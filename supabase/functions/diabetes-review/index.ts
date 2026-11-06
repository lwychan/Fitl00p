// Nightly pump-settings review (03:45 London, after diabetes-learn). Reads 28 days of Nightscout
// data (glucose, boluses incl. Control-IQ auto-boluses, delivered basal), the Apple Health
// workouts and daily sleep, and the learned model, then writes the outcome-driven suggestions
// (basal / carb ratio / correction factor by time of day) into dx_model.model.review. Suggestions
// only: nothing here changes the pump. ?force=1 runs outside the 03:xx window.

import { sbFetch, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';
import SettingsReview from '../_shared/settings-review.js';
import { fetchNightscoutInput } from '../_shared/nightscout-fetch.ts';

const SB_URL = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const REVIEW_HOUR_LONDON = 3;
const DAYS = 28;
const DAY = 86400000;
const HEADERS = { 'Content-Type': 'application/json' };
const iso = (ms: number) => new Date(ms).toISOString();

async function reviewUser(profile: any, nowMs: number) {
  const userId = profile.id;
  if (!profile.diabetes_pump_profile?.default?.length) return { status: 'skipped', reason: 'no-pump-profile' };
  const { data: rows } = await sbFetch(`/rest/v1/dx_model?user_id=eq.${userId}&select=fitted_at,model&order=fitted_at.desc&limit=1`);
  const row = (rows as any[])?.[0];
  if (!row?.model) return { status: 'skipped', reason: 'no-model' };

  const ns = await fetchNightscoutInput(profile, { days: DAYS });
  if (!ns || ns.fetchInfo?.truncated) return { status: 'skipped', reason: ns ? 'fetch-hit-count-limit' : 'nightscout-unreachable' };

  const since = nowMs - (DAYS + 1) * DAY;
  const [{ data: nightRows }, { data: wk }, { data: hd }] = await Promise.all([
    sbFetch(`/rest/v1/dx_episodes?user_id=eq.${userId}&kind=eq.night&start_at=gte.${iso(since)}&select=episode`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${iso(since)}&select=started_at,ended_at`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${iso(since).slice(0, 10)}&select=log_date,sleep_total_hrs`),
  ]);
  const workouts = ((wk as any[]) || []).map(w => ({ startMs: Date.parse(w.started_at), endMs: Date.parse(w.ended_at) })).filter(w => Number.isFinite(w.startMs) && Number.isFinite(w.endMs));
  const health: Record<string, any> = {};
  for (const h of (hd as any[]) || []) health[h.log_date] = { sleepHrs: h.sleep_total_hrs };

  const review = SettingsReview.settingsReview({
    model: row.model,
    nights: ((nightRows as any[]) || []).map(r => r.episode),
    pumpProfile: profile.diabetes_pump_profile,
    input: { glucoseHistory: ns.glucoseHistory, boluses: ns.boluses, corrections: ns.corrections, basalDoses: ns.basalDoses },
    targets: { low: profile.diabetes_target_low, high: profile.diabetes_target_high },
    context: { workouts, health },
    nowMs,
  });
  const res = await fetch(`${SB_URL}/rest/v1/dx_model?user_id=eq.${userId}&fitted_at=eq.${encodeURIComponent(row.fitted_at)}`, {
    method: 'PATCH',
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ model: { ...row.model, review } }),
  });
  if (!res.ok) throw new Error(`PATCH dx_model → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { status: 'reviewed', items: review.items.length, observations: review.observations.length, applied: review.applied.length,
    readings: ns.glucoseHistory.length, workouts: workouts.length };
}

Deno.serve(async (req: Request) => {
  if (!SB_URL || !SB_SERVICE) return new Response(JSON.stringify({ ok: false }), { status: 500, headers: HEADERS });
  const force = new URL(req.url).searchParams.get('force') === '1';
  if (!force && londonNow().hour !== REVIEW_HOUR_LONDON) return new Response(JSON.stringify({ ok: true }), { headers: HEADERS });
  const { data: profiles } = await sbFetch(
    '/rest/v1/profiles?diabetes_enabled=eq.true&diabetes_ns_url=not.is.null' +
    '&select=id,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_pump_profile');
  const nowMs = Date.now();
  const results: any[] = [];
  for (const profile of (profiles as any[]) || []) {
    if (profile.id === GEMMA_USER_ID) continue;
    const user = String(profile.id).slice(0, 8);
    try { results.push({ user, ...(await reviewUser(profile, nowMs)) }); }
    catch (err) { results.push({ user, status: 'error', error: (err as Error).message.slice(0, 300) }); }
  }
  console.log(JSON.stringify({ forced: force, results }));
  const ok = results.every(r => r.status !== 'error');
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500, headers: HEADERS });
});
