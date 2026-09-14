// netlify/functions/notify-glucose-forecast.js
// Scheduled: fires every 15 minutes, always (no day/hour self-gate — a
// hypo/hyper risk doesn't respect office hours the way a weigh-in or
// step-check reminder does). For each diabetes-enabled user with a
// Nightscout URL configured, pulls recent CGM/treatment data and runs
// hypoForecast2h/hyperForecast2h — the same 2h-ahead forecast the
// Diabetes tab's Simple View already shows in-app — and pushes a
// notification with a concrete suggested treatment when either crosses
// into real risk (moderate/high tier, not the mild "low" tier that's
// still above the actual low/high threshold).
//
// Dedup/escalation against the glucose_alerts table: fires once when a
// risk newly appears or gets worse, then re-fires only every
// RENOTIFY_COOLDOWN_MINUTES while it persists unresolved, then clears
// silently once the forecast returns to 'minimal' — same shape as a
// real CGM app's predictive alert, not a ping every 15 minutes for the
// same ongoing episode.
//
// Deliberately simpler than the live in-app forecast in two ways: no
// workout data (openWorkoutDropMmol stays 0 — a real effect, but pulling
// and profiling workout history on every 15-minute tick for every user
// is a lot of extra cost for a secondary refinement; the in-app forecast
// still has it), and Nightscout's own bolus carbs are used as-is rather
// than merged with fitl00p's macroMealLog (same simplification the MFP
// matching UI in app.js already accepts for its one exception).

const crypto = require('crypto');
const { sendWebPush, GEMMA_USER_ID } = require('./_lib/webpush');
const NightscoutAdapter = require('../../nightscout-adapter.js');
const DiabetesEngine = require('../../diabetes-engine.js');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const NS_LOOKBACK_DAYS = 14; // matches fetchDiabetesData()'s live default
const RENOTIFY_COOLDOWN_MINUTES = 45;
const TIER_ORDER = ['minimal', 'low', 'moderate', 'high'];
// 'low' tier on either forecast means "still on the right side of the
// threshold, just approaching it" — same grouping renderDxSimple already
// uses in-app (tier === 'minimal' || tier === 'low' get the calm path).
// A push notification is a more disruptive interruption than in-app text,
// so it's reserved for the tiers that actually cross the line.
const NOTIFY_MIN_TIER_INDEX = TIER_ORDER.indexOf('moderate');

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}
async function sbUpsert(path, body) {
  await fetch(`${SB_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}
async function sbDelete(path) {
  await fetch(`${SB_URL}${path}`, {
    method: 'DELETE',
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  }).catch(() => {});
}

async function nsFetch(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  }
}

async function fetchNightscoutInput(profile) {
  const baseUrl = (profile.diabetes_ns_url || '').replace(/\/+$/, '');
  if (!baseUrl) return null;
  const sinceMs = Date.now() - NS_LOOKBACK_DAYS * 24 * 60 * 60000;
  const reqHeaders = {};
  if (profile.diabetes_ns_secret) reqHeaders['API-SECRET'] = crypto.createHash('sha1').update(profile.diabetes_ns_secret).digest('hex');
  const tokenQS = profile.diabetes_ns_token ? `&token=${encodeURIComponent(profile.diabetes_ns_token)}` : '';

  const [entries, treatments] = await Promise.all([
    nsFetch(`${baseUrl}/api/v1/entries.json?count=20000&find[date][$gte]=${sinceMs}${tokenQS}`, reqHeaders),
    nsFetch(`${baseUrl}/api/v1/treatments.json?count=5000&find[created_at][$gte]=${new Date(sinceMs).toISOString()}${tokenQS}`, reqHeaders),
  ]);
  if (!entries.ok) return null;

  const adapted = NightscoutAdapter.adaptNightscoutData({
    entries: entries.data || [],
    treatments: treatments.ok ? (treatments.data || []) : [],
  });

  const settings = {
    targetLow: Number(profile.diabetes_target_low) || 3.9,
    targetHigh: Number(profile.diabetes_target_high) || 9.9,
    idealTarget: Number(profile.diabetes_ideal_target) || 6.1,
    carbRatio: Number(profile.diabetes_carb_ratio) || null,
    correctionFactor: Number(profile.diabetes_correction_factor) || null,
    insulinPeakMinutes: Number(profile.diabetes_insulin_peak_min) || 75,
    insulinDurationMinutes: Number(profile.diabetes_insulin_duration_min) || 240,
  };

  return { ...adapted, settings, activities: {} };
}

function buildLowMessage(forecast, input) {
  const advice = DiabetesEngine.preventativeCarbAdvice(forecast.forecastGlucose, 120, forecast.factor, input.settings);
  const carbsText = advice.gramsNeeded > 0 ? `~${advice.gramsNeeded}g fast carbs` : 'fast-acting carbs';
  return {
    title: '⬇️ Low predicted',
    body: `Glucose heading toward ~${forecast.forecastGlucose.toFixed(1)} mmol/L in the next 2h — try ${carbsText} now.`,
  };
}
function buildHighMessage(forecast) {
  const doseText = forecast.suggestedUnits > 0 ? `~${forecast.suggestedUnits.toFixed(2)}u correction` : 'a correction';
  return {
    title: '⬆️ High predicted',
    body: `Glucose heading toward ~${forecast.forecastGlucose.toFixed(1)} mmol/L in the next 2h — consider ${doseText} (check IOB first).`,
  };
}

// Decides whether this direction's current tier is worth a fresh push,
// given whatever alert state (if any) was last recorded for it, and
// returns the state row to write afterward (or null to clear it).
function evaluateAlertState(tier, existing, nowMs) {
  const tierIdx = TIER_ORDER.indexOf(tier);
  if (tierIdx < NOTIFY_MIN_TIER_INDEX) {
    return { shouldNotify: false, clear: !!existing };
  }
  if (!existing) return { shouldNotify: true, clear: false };

  const existingIdx = TIER_ORDER.indexOf(existing.tier);
  const minutesSince = (nowMs - new Date(existing.notified_at).getTime()) / 60000;
  const escalated = tierIdx > existingIdx;
  const cooledDown = minutesSince >= RENOTIFY_COOLDOWN_MINUTES;
  return { shouldNotify: escalated || cooledDown, clear: false };
}

// Named exports alongside exports.handler purely so the pure logic below
// (no network calls) is unit-testable without mocking Supabase/Nightscout
// fetches — Netlify only ever calls .handler, these are inert to it.
module.exports.evaluateAlertState = evaluateAlertState;
module.exports.buildLowMessage = buildLowMessage;
module.exports.buildHighMessage = buildHighMessage;
module.exports.fetchNightscoutInput = fetchNightscoutInput;

exports.handler = async function () {
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };
  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  const { data: profiles } = await sbFetch(
    '/rest/v1/profiles?diabetes_enabled=eq.true&diabetes_ns_url=not.is.null' +
    '&select=id,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min'
  );
  if (!profiles?.length) return { statusCode: 200, body: 'no diabetes-enabled profiles' };

  let sent = 0, failed = 0, skipped = 0;
  const nowMs = Date.now();

  for (const profile of profiles) {
    const userId = profile.id;
    if (userId === GEMMA_USER_ID) continue; // doesn't use diabetes tracking
    const userSubs = byUser[userId];
    if (!userSubs?.length) continue;

    const input = await fetchNightscoutInput(profile);
    if (!input) { skipped++; continue; }

    const { data: alertRows } = await sbFetch(`/rest/v1/glucose_alerts?user_id=eq.${userId}&select=direction,tier,notified_at`);
    const existingByDirection = {};
    (alertRows || []).forEach(r => { existingByDirection[r.direction] = r; });

    const checks = [
      { direction: 'low', forecast: DiabetesEngine.hypoForecast2h(input, nowMs), buildMessage: f => buildLowMessage(f, input) },
      { direction: 'high', forecast: DiabetesEngine.hyperForecast2h(input, nowMs), buildMessage: buildHighMessage },
    ];

    for (const { direction, forecast, buildMessage } of checks) {
      if (forecast.withheldReason || !forecast.tier) continue;
      const decision = evaluateAlertState(forecast.tier, existingByDirection[direction], nowMs);

      if (decision.clear) {
        await sbDelete(`/rest/v1/glucose_alerts?user_id=eq.${userId}&direction=eq.${direction}`);
        continue;
      }
      if (!decision.shouldNotify) continue;

      const { title, body } = buildMessage(forecast);
      const payload = { title, body, url: '/', tag: `glucose-forecast-${direction}` };
      let anySent = false;
      for (const s of userSubs) {
        try {
          const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
          if (r.status >= 200 && r.status < 300) { sent++; anySent = true; } else failed++;
        } catch { failed++; }
      }
      if (anySent) {
        await sbUpsert('/rest/v1/glucose_alerts', {
          user_id: userId, direction, tier: forecast.tier,
          forecast_glucose: forecast.forecastGlucose, notified_at: new Date(nowMs).toISOString(),
        });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
