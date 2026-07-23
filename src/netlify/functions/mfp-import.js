// netlify/functions/mfp-import.js
// Receives a diary payload from the MFP-import bookmarklet (see
// buildMfpBookmarklet() in app.js) — the bookmarklet runs in the user's
// own authenticated MyFitnessPal tab, reads the diary DOM directly
// (same-origin, no scraping/Cloudflare issue), and POSTs the parsed
// items here. This function never talks to MyFitnessPal itself.
//
// Each item is paired against the user's recent Nightscout boluses
// (nearest-in-time + closest-in-carbs) or, if nothing matches and the
// user's glucose is low/falling, auto-tagged as a hypo treatment that
// doesn't need a bolus at all. Anything else is left for manual review
// in the Diabetes tab.

const crypto = require('crypto');
const { adaptNightscoutData } = require('../../nightscout-adapter.js');
const DiabetesEngine = require('../../diabetes-engine.js');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const MAX_ITEMS = 200;
const MATCH_WINDOW_MIN = 90;       // how far from "now" a bolus can be and still be a candidate
const UNMATCHED_TIME_ONLY_WINDOW_MIN = 30; // tighter window when an item has no carb figure to match on
const HYPO_GLUCOSE_THRESHOLD = 5.8;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token, date, items } = body || {};
  if (!token) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing token' }) };
  if (!Array.isArray(items) || !items.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No items in payload' }) };
  }
  if (items.length > MAX_ITEMS) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Too many items (max ${MAX_ITEMS})` }) };
  }

  const profileRes = await sbFetch(
    `/rest/v1/profiles?diabetes_mfp_import_token=eq.${encodeURIComponent(token)}&select=id,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min`
  );
  const profile = profileRes.ok ? profileRes.data?.[0] : null;
  if (!profile) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unrecognized import token — regenerate the bookmarklet in fitl00p Settings.' }) };
  }
  const userId = profile.id;

  const settings = {
    targetLow:  profile.diabetes_target_low ?? 4.5,
    targetHigh: profile.diabetes_target_high ?? 8.5,
    idealTarget: profile.diabetes_ideal_target,
    carbRatio: profile.diabetes_carb_ratio,
    correctionFactor: profile.diabetes_correction_factor,
    insulinPeakMinutes: profile.diabetes_insulin_peak_min ?? 57,
    insulinDurationMinutes: profile.diabetes_insulin_duration_min ?? 240,
  };

  // Pull a day's worth of Nightscout history — enough to both match
  // against existing boluses (if the user already dosed before syncing)
  // and to compute a live dose suggestion (if they're syncing to decide
  // what to bolus, which is now the primary path).
  let boluses = [], nsData = null, ctx = { stale: true, currentGlucose: null, effectiveGlucose: null };
  if (profile.diabetes_ns_url) {
    nsData = await fetchNightscoutWindow(profile);
    if (nsData) {
      boluses = nsData.boluses || [];
      ctx = DiabetesEngine.dosingContext({ ...nsData, settings }, Date.now());
    }
  }
  const macroMealLog = await fetchMacroMealLogForUser(userId);

  const nowMs = Date.now();
  const importDate = date || new Date(nowMs).toISOString().slice(0, 10);

  const results = { imported: 0, skippedDuplicate: 0, skippedInvalid: 0, autoMatched: 0, hypoTagged: 0, suggested: 0, unmatched: 0, suggestions: [] };
  const rows = [];

  for (const raw of items) {
    const name = String(raw?.name || '').trim();
    const mealSection = String(raw?.mealSection || '').trim().toLowerCase();
    const carbsG = numOrNull(raw?.carbsG);
    const fatG = numOrNull(raw?.fatG) || 0;
    const proteinG = numOrNull(raw?.proteinG) || 0;

    if (!name || (carbsG == null && !fatG && !proteinG)) {
      results.skippedInvalid++;
      continue;
    }

    const fingerprint = crypto.createHash('sha1').update(`${importDate}|${mealSection}|${name.toLowerCase()}`).digest('hex');

    // Priority order matters here: an already-existing bolus (they'd
    // already dosed before syncing) always wins over computing a fresh
    // suggestion. Below that, suggestMacroMealDose is always given the
    // chance to run — it already reduces/floors the dose using current
    // glucose and IOB, which is the correct way to handle "a bit low but
    // eating a normal meal." Only when its own math floors to zero AND
    // glucose is actually low/falling do we call it a hypo treatment;
    // that's more accurate than gating on the glucose threshold alone,
    // which would also suppress legitimate reduced-but-nonzero doses.
    let matchStatus = 'unmatched';
    let matchedBolusTime = null;
    let matchedBolusUnits = null;
    let doseFields = {};
    let suggestionForResponse = null;

    const match = findBestBolusMatch(boluses, carbsG, nowMs);
    if (match) {
      matchStatus = 'auto';
      matchedBolusTime = new Date(match.time).toISOString();
      matchedBolusUnits = match.units;
      results.autoMatched++;
    } else {
      const meal = { carbs: carbsG || 0, fat: fatG || 0, protein: proteinG || 0, mealName: name };
      const engineInput = {
        glucoseHistory: nsData?.glucoseHistory || [],
        boluses: nsData?.boluses || [],
        corrections: nsData?.corrections || [],
        settings,
        macroMealLog,
      };
      const doseResult = DiabetesEngine.suggestMacroMealDose(engineInput, meal, nowMs);
      const lowOrFalling = !ctx.stale && ctx.currentGlucose != null &&
        (ctx.currentGlucose < HYPO_GLUCOSE_THRESHOLD || (ctx.effectiveGlucose != null && ctx.effectiveGlucose < HYPO_GLUCOSE_THRESHOLD));

      if (doseResult.suggestedUnits == null) {
        matchStatus = 'unmatched';
        results.unmatched++;
        suggestionForResponse = { name, withheldReason: doseResult.withheldReason };
      } else if (doseResult.suggestedUnits === 0 && lowOrFalling) {
        matchStatus = 'hypo-auto';
        results.hypoTagged++;
        suggestionForResponse = { name, hypoTreatment: true };
      } else {
        matchStatus = 'suggested';
        results.suggested++;
        doseFields = {
          suggested_units: doseResult.suggestedUnits,
          upfront_units: doseResult.upfrontUnits,
          delayed_units: doseResult.delayedUnits,
          dose_source: doseResult.personalized ? `mfp-auto:${doseResult.personalizedBy}` : 'mfp-auto',
        };
        suggestionForResponse = {
          name,
          suggestedUnits: doseResult.suggestedUnits,
          upfrontUnits: doseResult.upfrontUnits,
          delayedUnits: doseResult.delayedUnits,
          splitTier: doseResult.guide?.tier || 'single',
          lowGlucoseWarning: !!doseResult.lowGlucoseWarning,
        };
      }
    }

    if (suggestionForResponse) results.suggestions.push(suggestionForResponse);

    rows.push({
      user_id: userId,
      eaten_at: new Date(nowMs).toISOString(),
      meal_name: name,
      carbs_g: carbsG ?? 0,
      fat_g: fatG,
      protein_g: proteinG,
      source: 'mfp',
      hypo_treatment: matchStatus === 'hypo-auto',
      match_status: matchStatus,
      matched_bolus_time: matchedBolusTime,
      matched_bolus_units: matchedBolusUnits,
      mfp_fingerprint: fingerprint,
      ...doseFields,
    });
  }

  if (rows.length) {
    // on_conflict + Prefer: resolution=ignore-duplicates makes the unique
    // (user_id, mfp_fingerprint) index a no-op dedup rather than an error —
    // safe to re-run the bookmarklet on the same diary any number of times.
    const insertRes = await sbFetch(
      `/rest/v1/diabetes_meals?on_conflict=user_id,mfp_fingerprint`, 'POST', rows,
      { 'Prefer': 'return=representation,resolution=ignore-duplicates' }
    );
    if (!insertRes.ok) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to save imported meals', detail: insertRes.error }) };
    }
    results.imported = insertRes.data?.length || 0;
    results.skippedDuplicate = rows.length - results.imported;
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...results }) };
};

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? n : null;
}

function findBestBolusMatch(boluses, carbsG, nowMs) {
  let best = null, bestScore = Infinity;
  for (const b of boluses) {
    const time = Number(b.time);
    const units = Number(b.units);
    if (!Number.isFinite(time) || !Number.isFinite(units) || units <= 0) continue;
    const timeDeltaMin = Math.abs(nowMs - time) / 60000;

    if (carbsG == null) {
      if (timeDeltaMin > UNMATCHED_TIME_ONLY_WINDOW_MIN) continue;
      if (timeDeltaMin < bestScore) { bestScore = timeDeltaMin; best = b; }
      continue;
    }

    if (timeDeltaMin > MATCH_WINDOW_MIN) continue;
    const bolusCarbsG = Number(b.carbs) || 0;
    const carbDelta = Math.abs(bolusCarbsG - carbsG);
    const carbTolerance = Math.max(15, carbsG * 0.4);
    if (carbDelta > carbTolerance) continue;
    const score = timeDeltaMin + carbDelta * 2;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  return best;
}

async function fetchMacroMealLogForUser(userId) {
  const res = await sbFetch(`/rest/v1/diabetes_meals?user_id=eq.${userId}&select=eaten_at,meal_name,carbs_g,fat_g,protein_g&order=eaten_at.desc&limit=200`);
  if (!res.ok) return [];
  return (res.data || []).map(r => ({
    time: new Date(r.eaten_at).getTime(),
    mealName: r.meal_name || null,
    carbs: Number(r.carbs_g),
    fat: Number(r.fat_g),
    protein: Number(r.protein_g),
  }));
}

async function fetchNightscoutWindow(profile) {
  const baseUrl = (profile.diabetes_ns_url || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const sinceMs = Date.now() - 24 * 60 * 60000;
  const reqHeaders = {};
  if (profile.diabetes_ns_secret) reqHeaders['API-SECRET'] = crypto.createHash('sha1').update(profile.diabetes_ns_secret).digest('hex');
  const tokenQS = profile.diabetes_ns_token ? `&token=${encodeURIComponent(profile.diabetes_ns_token)}` : '';

  try {
    const [entriesRes, treatmentsRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/entries.json?count=2000&find[date][$gte]=${sinceMs}${tokenQS}`, { headers: reqHeaders }),
      fetch(`${baseUrl}/api/v1/treatments.json?count=500&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, { headers: reqHeaders }),
    ]);
    const entries = entriesRes.ok ? await entriesRes.json() : [];
    const treatments = treatmentsRes.ok ? await treatmentsRes.json() : [];
    return adaptNightscoutData({ entries, treatments });
  } catch {
    return null;
  }
}

async function sbFetch(path, method = 'GET', body = null, extraHeaders = {}) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    let error = null;
    if (!res.ok) { try { error = await res.text(); } catch {} }
    return { ok: res.ok, status: res.status, data, error };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}
