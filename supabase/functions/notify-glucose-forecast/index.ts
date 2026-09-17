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
//
// Ported from src/netlify/functions/notify-glucose-forecast.js —
// mechanical translation to Deno.serve; logic unchanged. fetchNightscoutInput
// itself now lives in _shared/nightscout-fetch.ts (shared with
// notify-ai-coach) rather than being duplicated here — see that file's
// header comment for why importing one function's index.ts from another
// isn't safe under Deno.serve.

import { sendWebPush, GEMMA_USER_ID } from '../_shared/webpush.ts';
import DiabetesEngine from '../_shared/diabetes-engine.ts';
import { fetchNightscoutInput } from '../_shared/nightscout-fetch.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const RENOTIFY_COOLDOWN_MINUTES = 45;
const TIER_ORDER = ['minimal', 'low', 'moderate', 'high'];
// 'low' tier on either forecast means "still on the right side of the
// threshold, just approaching it" — same grouping renderDxSimple already
// uses in-app (tier === 'minimal' || tier === 'low' get the calm path).
// A push notification is a more disruptive interruption than in-app text,
// so it's reserved for the tiers that actually cross the line.
const NOTIFY_MIN_TIER_INDEX = TIER_ORDER.indexOf('moderate');

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}
async function sbUpsert(path: string, body: unknown) {
  await fetch(`${SB_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}
async function sbDelete(path: string) {
  await fetch(`${SB_URL}${path}`, {
    method: 'DELETE',
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  }).catch(() => {});
}

function buildLowMessage(forecast: any, input: any) {
  const advice = DiabetesEngine.preventativeCarbAdvice(forecast.forecastGlucose, 120, forecast.factor, input.settings);
  const carbsText = advice.gramsNeeded > 0 ? `~${advice.gramsNeeded}g fast carbs` : 'fast-acting carbs';
  return {
    title: '⬇️ Low predicted',
    body: `Glucose heading toward ~${forecast.forecastGlucose.toFixed(1)} mmol/L in the next 2h — try ${carbsText} now.`,
  };
}
function buildHighMessage(forecast: any) {
  const doseText = forecast.suggestedUnits > 0 ? `~${forecast.suggestedUnits.toFixed(2)}u correction` : 'a correction';
  return {
    title: '⬆️ High predicted',
    body: `Glucose heading toward ~${forecast.forecastGlucose.toFixed(1)} mmol/L in the next 2h — consider ${doseText} (check IOB first).`,
  };
}

// Decides whether this direction's current tier is worth a fresh push,
// given whatever alert state (if any) was last recorded for it, and
// returns the state row to write afterward (or null to clear it).
function evaluateAlertState(tier: string, existing: any, nowMs: number) {
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

// Named exports alongside the Deno.serve handler below purely so the pure
// logic above (no network calls) stays unit-testable without mocking
// Supabase/Nightscout fetches, same intent as the Netlify original.
export { evaluateAlertState, buildLowMessage, buildHighMessage, fetchNightscoutInput };

Deno.serve(async () => {
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!(subs as any[])?.length) return new Response('no subscriptions');
  const byUser: Record<string, any[]> = {};
  (subs as any[]).forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  const { data: prefsRows } = await sbFetch(`/rest/v1/notification_prefs?notif_key=eq.glucose_forecast&select=user_id,enabled`);
  const prefsByUser: Record<string, any> = {};
  ((prefsRows as any[]) || []).forEach(p => { prefsByUser[p.user_id] = p; });

  const { data: profiles } = await sbFetch(
    '/rest/v1/profiles?diabetes_enabled=eq.true&diabetes_ns_url=not.is.null' +
    '&select=id,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min'
  );
  if (!(profiles as any[])?.length) return new Response('no diabetes-enabled profiles');

  let sent = 0, failed = 0, skipped = 0;
  const nowMs = Date.now();

  for (const profile of profiles as any[]) {
    const userId = profile.id;
    if (userId === GEMMA_USER_ID) continue; // doesn't use diabetes tracking
    if (prefsByUser[userId]?.enabled === false) { skipped++; continue; }
    const userSubs = byUser[userId];
    if (!userSubs?.length) continue;

    const input = await fetchNightscoutInput(profile);
    if (!input) { skipped++; continue; }

    const { data: alertRows } = await sbFetch(`/rest/v1/glucose_alerts?user_id=eq.${userId}&select=direction,tier,notified_at`);
    const existingByDirection: Record<string, any> = {};
    ((alertRows as any[]) || []).forEach(r => { existingByDirection[r.direction] = r; });

    const checks = [
      { direction: 'low', forecast: DiabetesEngine.hypoForecast2h(input, nowMs), buildMessage: (f: any) => buildLowMessage(f, input) },
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

  return new Response(JSON.stringify({ sent, failed, skipped }));
});
