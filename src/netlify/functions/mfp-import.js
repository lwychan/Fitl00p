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
const MAX_BACKFILL_ITEMS = 400;
const MATCH_WINDOW_MIN = 90;       // how far from "now" a bolus can be and still be a candidate
const UNMATCHED_TIME_ONLY_WINDOW_MIN = 30; // tighter window when an item has no carb figure to match on
const HYPO_GLUCOSE_THRESHOLD = 5.8;

// Backfill has no "near now" to anchor matching on — MFP never records a
// time-of-day, only a meal section — so instead of a tight time window it
// uses wide, generous UTC-hour buckets per section (loose enough to cover
// a broad range of timezones/routines) combined with a *tight* carb
// tolerance and a strict uniqueness rule (findBestBolusMatchStrict below):
// only auto-match when exactly one candidate clears both bars. Wide time
// windows are safe under that rule — they only add candidates, and an
// ambiguous day with multiple plausible candidates correctly falls
// through to unmatched rather than guessing.
const BACKFILL_SECTION_WINDOWS_UTC = {
  breakfast: [3, 12],
  lunch: [10, 16],
  dinner: [15, 22],
  snacks: [0, 24],
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { token } = body || {};
  if (!token) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing token' }) };

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

  if (body.backfill === true) {
    return handleBackfill(profile, settings, body, userId);
  }

  const { date, items } = body;
  if (!Array.isArray(items) || !items.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No items in payload' }) };
  }
  if (items.length > MAX_ITEMS) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Too many items (max ${MAX_ITEMS})` }) };
  }

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

async function fetchNightscoutWindow(profile, days = 1) {
  const baseUrl = (profile.diabetes_ns_url || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const sinceMs = Date.now() - days * 24 * 60 * 60000;
  const reqHeaders = {};
  if (profile.diabetes_ns_secret) reqHeaders['API-SECRET'] = crypto.createHash('sha1').update(profile.diabetes_ns_secret).digest('hex');
  const tokenQS = profile.diabetes_ns_token ? `&token=${encodeURIComponent(profile.diabetes_ns_token)}` : '';
  // Nightscout's entries count cap needs to scale with the window — the
  // live 1-day path's fixed 2000 is already generous for a 5-min CGM
  // cadence (~288/day), but a 14+-day backfill window needs proportionally
  // more room or older entries silently get cut off.
  const entriesCount = Math.max(2000, days * 300);

  try {
    const [entriesRes, treatmentsRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/entries.json?count=${entriesCount}&find[date][$gte]=${sinceMs}${tokenQS}`, { headers: reqHeaders }),
      fetch(`${baseUrl}/api/v1/treatments.json?count=500&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, { headers: reqHeaders }),
    ]);
    const entries = entriesRes.ok ? await entriesRes.json() : [];
    const treatments = treatmentsRes.ok ? await treatmentsRes.json() : [];
    return adaptNightscoutData({ entries, treatments });
  } catch {
    return null;
  }
}

// Backfill matching: only auto-match when there's exactly one candidate
// bolus that clears BOTH a wide section-of-day window AND a tight carb
// tolerance. Zero candidates or more than one (ambiguous — e.g. two
// similar-carb meals close together) both fall through to null, left for
// manual linking rather than guessed at.
function findBestBolusMatchStrict(boluses, carbsG, mealSection, dateStr) {
  if (carbsG == null) return null; // no carb figure — nothing to be confident about
  const [startH, endH] = BACKFILL_SECTION_WINDOWS_UTC[mealSection] || BACKFILL_SECTION_WINDOWS_UTC.snacks;
  const dayStartMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  const windowStart = dayStartMs + startH * 3600000;
  const windowEnd = dayStartMs + endH * 3600000;
  const tolerance = Math.max(8, carbsG * 0.2);

  const candidates = boluses.filter(b => {
    const time = Number(b.time);
    const units = Number(b.units);
    if (!Number.isFinite(time) || !Number.isFinite(units) || units <= 0) return false;
    if (time < windowStart || time > windowEnd) return false;
    const bolusCarbsG = Number(b.carbs) || 0;
    return Math.abs(bolusCarbsG - carbsG) <= tolerance;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

// Backfill entry point — a batch of {date, items[]} spanning many days at
// once (see the Shortcuts backfill script), matched against a single wide
// Nightscout fetch covering the whole range. No suggestion computation
// here (see suggestMacroMealDose in the live path above): a "what should
// I dose right now" calculation doesn't make sense for something that
// already happened days ago, so unmatched historical items are recorded
// with the raw meal data and left for manual linking, not a guessed dose.
async function handleBackfill(profile, settings, body, userId) {
  const days = Array.isArray(body.days) ? body.days : [];
  if (!days.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No days in backfill payload' }) };
  }
  const totalItems = days.reduce((s, d) => s + (Array.isArray(d.items) ? d.items.length : 0), 0);
  if (totalItems > MAX_BACKFILL_ITEMS) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `Too many items across all days (max ${MAX_BACKFILL_ITEMS})` }) };
  }
  if (!profile.diabetes_ns_url) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Connect Nightscout in Settings before backfilling — matching needs your bolus history.' }) };
  }

  const spanDays = Math.max(1, days.length) + 1; // +1 day slack for timezone edge cases at the range boundary
  const nsData = await fetchNightscoutWindow(profile, spanDays);
  if (!nsData) {
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ error: 'Could not reach Nightscout for backfill matching.' }) };
  }
  const boluses = nsData.boluses || [];
  const glucoseHistory = nsData.glucoseHistory || [];

  const results = { imported: 0, skippedDuplicate: 0, skippedInvalid: 0, autoMatched: 0, hypoTagged: 0, unmatched: 0, daysProcessed: days.length };
  const rows = [];

  for (const day of days) {
    const dateStr = String(day?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
    const items = Array.isArray(day.items) ? day.items : [];

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

      const fingerprint = crypto.createHash('sha1').update(`${dateStr}|${mealSection}|${name.toLowerCase()}`).digest('hex');
      const [startH, endH] = BACKFILL_SECTION_WINDOWS_UTC[mealSection] || BACKFILL_SECTION_WINDOWS_UTC.snacks;
      const dayStartMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
      const windowStart = dayStartMs + startH * 3600000;
      const windowEnd = dayStartMs + endH * 3600000;

      let matchStatus = 'unmatched';
      let matchedBolusTime = null;
      let matchedBolusUnits = null;
      let eatenAtMs = (windowStart + windowEnd) / 2; // placeholder for unmatched rows — only used for sorting/display, never for a dose rating

      const match = findBestBolusMatchStrict(boluses, carbsG, mealSection, dateStr);
      if (match) {
        matchStatus = 'auto';
        matchedBolusTime = new Date(match.time).toISOString();
        matchedBolusUnits = match.units;
        eatenAtMs = match.time;
        results.autoMatched++;
      } else {
        // Not confident enough to pin a dose to this item — but still
        // worth flagging as a hypo treatment if glucose was genuinely low
        // at some point across this meal's whole plausible time range,
        // so it doesn't sit there asking to be linked to a bolus that
        // was never coming.
        const windowReadings = glucoseHistory
          .map(r => ({ ms: Number(r.time), value: Number(r.value) }))
          .filter(r => Number.isFinite(r.ms) && Number.isFinite(r.value) && r.ms >= windowStart && r.ms <= windowEnd);
        const minInWindow = windowReadings.length ? Math.min(...windowReadings.map(r => r.value)) : null;
        if (minInWindow != null && minInWindow < HYPO_GLUCOSE_THRESHOLD) {
          matchStatus = 'hypo-auto';
          results.hypoTagged++;
        } else {
          results.unmatched++;
        }
      }

      rows.push({
        user_id: userId,
        eaten_at: new Date(eatenAtMs).toISOString(),
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
      });
    }
  }

  if (rows.length) {
    const insertRes = await sbFetch(
      `/rest/v1/diabetes_meals?on_conflict=user_id,mfp_fingerprint`, 'POST', rows,
      { 'Prefer': 'return=representation,resolution=ignore-duplicates' }
    );
    if (!insertRes.ok) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Failed to save backfilled meals', detail: insertRes.error }) };
    }
    results.imported = insertRes.data?.length || 0;
    results.skippedDuplicate = rows.length - results.imported;
  }

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, ...results }) };
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
