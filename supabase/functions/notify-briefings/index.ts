// Scheduled every 15 min (cron 'notify-briefings'). Sends each person ONE
// morning briefing at their morning time (Lewis 05:45 weekdays / 07:30
// weekends, Gemma 07:30 — src/briefings.js, editable in Settings via
// profiles.briefing_schedule) and ONE evening briefing an hour before their
// suggested bedtime. Messages are composed from insight_rules parts
// (headline / reason / action) by Briefings.composeBriefing — no AI.
// briefing_log is written before sending, so a briefing can never go twice.

import { sendToSubscriptions, sbFetch, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';
import { computeRecoveryScore, computeSleepScore, computeStrainScoreTrimp, computeSleepNeed } from '../_shared/health-scores.ts';
import { fetchNightscoutInput } from '../_shared/nightscout-fetch.ts';
import ReadinessModel from '../_shared/readiness-model.js';
import Insights from '../_shared/insights.js';
import Briefings from '../_shared/briefings.js';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function sbWrite(path: string, method: string, body: unknown, prefer: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    method,
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json', Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status}: ${await res.text()}`);
  return prefer.includes('return=representation') ? res.json() : null;
}

// Claim today's (user, kind) slot; true only for the run that inserted it.
async function claim(userId: string, kind: string, dateStr: string) {
  const rows = await sbWrite('/rest/v1/briefing_log?on_conflict=user_id,kind,sent_date', 'POST',
    { user_id: userId, kind, sent_date: dateStr }, 'resolution=ignore-duplicates,return=representation');
  return Array.isArray(rows) && rows.length > 0;
}
async function recordBody(userId: string, kind: string, dateStr: string, body: string) {
  await sbWrite(`/rest/v1/briefing_log?user_id=eq.${userId}&kind=eq.${kind}&sent_date=eq.${dateStr}`, 'PATCH',
    { body }, 'return=minimal').catch(() => {});
}

// Same SD-based z-score the app uses (bbZScore in app.js).
function zScore(hist: any[], field: string, date: string, value: any, log: boolean, floor: number) {
  const stats = ReadinessModel.personalBaseline(hist, field, date, { log });
  if (!stats || value == null || (log && !(value > 0))) return null;
  return ((log ? Math.log(value) : Number(value)) - stats.mean) / Math.max(stats.sd, floor);
}

// Everything the server knows about today, as the rules' metrics (the same
// context notify-daily-summary used, plus glucose when Nightscout is set up).
async function buildContext(userId: string, profile: any, todayStr: string, nowHour: number) {
  const yesterdayStr = addDays(todayStr, -1);
  const windowStart = addDays(todayStr, -40);
  const [{ data: healthRows }, { data: workoutRows }, { data: maxRows }, { data: foodRows }, { data: logRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${windowStart}&log_date=lte.${todayStr}&select=log_date,hrv_ms,resting_hr,respiratory_rate,wrist_temp_dev,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,resting_energy_kcal,dietary_energy_kcal,weight_kg,steps&order=log_date.asc`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${addDays(todayStr, -8)}T00:00:00Z&select=workout_type,avg_heart_rate,started_at,ended_at,active_energy_kcal&order=started_at.desc`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${addDays(todayStr, -180)}T00:00:00Z&max_heart_rate=not.is.null&select=max_heart_rate&order=max_heart_rate.desc&limit=2`),
    sbFetch(`/rest/v1/food_log?user_id=eq.${userId}&log_date=gte.${addDays(todayStr, -8)}&select=log_date,calories_kcal`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=gte.${addDays(todayStr, -15)}&select=log_date,weight,cal_mfp`),
  ]);
  const workouts = (workoutRows as any[]) || [];
  const logs = (logRows as any[]) || [];
  const food: Record<string, number> = {};
  ((foodRows as any[]) || []).forEach(r => { food[r.log_date] = (food[r.log_date] || 0) + (Number(r.calories_kcal) || 0); });
  const mfp: Record<string, number> = {};
  logs.forEach(l => { if (l.cal_mfp != null) mfp[l.log_date] = Number(l.cal_mfp); });
  const health = ((healthRows as any[]) || []).map(h => ({ ...h, cal_fitl00p: food[h.log_date] ?? null, cal_mfp: mfp[h.log_date] ?? null }));

  const todayHealth     = health.find((h: any) => h.log_date === todayStr) || {};
  const yesterdayHealth = health.find((h: any) => h.log_date === yesterdayStr) || null;
  const inDay = (w: any, d: string, next: string) => w.started_at >= `${d}T00:00:00` && w.started_at < `${next}T00:00:00`;
  const hrMax2 = (maxRows as any[])?.[1]?.max_heart_rate ?? null;
  const female = profile.sex === 'female';

  const recovery = computeRecoveryScore(todayHealth, health, profile.recovery_weights ?? null);
  const sleep    = computeSleepScore(todayHealth, health);
  const strainY  = computeStrainScoreTrimp(yesterdayHealth, null, workouts.filter(w => inDay(w, yesterdayStr, todayStr)), profile.age_years, female, hrMax2);
  const strainT  = computeStrainScoreTrimp(todayHealth, null, workouts.filter(w => inDay(w, todayStr, addDays(todayStr, 1))), profile.age_years, female, hrMax2);

  const ctx: Record<string, any> = { hour: nowHour };
  if (recovery.score != null) {
    ctx.recovery = recovery.score;
    ctx.strain_target_lo = recovery.score >= 67 ? 14 : recovery.score >= 34 ? 9 : 0;
    ctx.strain_target_hi = recovery.score >= 67 ? 18 : recovery.score >= 34 ? 13.5 : 8;
  }
  if (sleep.score != null) ctx.sleep_score = sleep.score;
  const lastNight = computeSleepNeed(health, todayStr, null);
  if (todayHealth.sleep_total_hrs != null) {
    ctx.sleep_hrs = Number(todayHealth.sleep_total_hrs);
    ctx.sleep_perf = Math.round((ctx.sleep_hrs / lastNight.needHours) * 100);
  }
  ctx.hrv_z = zScore(health, 'hrv_ms', todayStr, todayHealth.hrv_ms, true, 0.05);
  ctx.rhr_z = zScore(health, 'resting_hr', todayStr, todayHealth.resting_hr, false, 1);
  ctx.rr_z = zScore(health, 'respiratory_rate', todayStr, todayHealth.respiratory_rate, false, 0.25);
  if (todayHealth.wrist_temp_dev != null) ctx.wrist_temp = Number(todayHealth.wrist_temp_dev);
  if (strainY.score != null) ctx.strain_yday = strainY.score;
  Object.assign(ctx, Insights.healthTrendMetrics(health, todayStr));
  Object.assign(ctx, Insights.dailyContextMetrics({
    day: todayStr, nowMs: Date.now(), history: health,
    weights: logs.filter(l => l.weight != null), workouts, hasPlan: false,
    steps: todayHealth.steps ?? null, consumed: food[todayStr] ?? null,
  }));
  delete ctx.has_plan; // unknown here — keeps plan-only rules out

  // Glucose (Lewis): Nightscout, independent of the phone.
  let readings: any[] = [];
  if (profile.diabetes_enabled && profile.diabetes_ns_url) {
    const ns = await fetchNightscoutInput(profile).catch(() => null);
    readings = ns?.glucoseHistory || [];
    Object.assign(ctx, Insights.glucoseMetrics(readings, Date.now(), Briefings.londonMidnightMs(todayStr)));
  }
  for (const k of Object.keys(ctx)) if (ctx[k] == null || Number.isNaN(ctx[k])) delete ctx[k];

  return { ctx, health, todayHealth, readings, strainToday: strainT, strainYday: strainY,
    weighedToday: todayHealth.weight_kg != null || logs.some(l => l.log_date === todayStr && l.weight != null) };
}

function itemsFor(rules: any[], ctx: any, slot: string) {
  const slotRules = rules.filter(r => r.slot === slot || r.slot === 'both');
  return Insights.evaluateInsights(slotRules, ctx, { max: 8 });
}

async function tirzepatideDueToday(userId: string, todayStr: string) {
  const { data } = await sbFetch(`/rest/v1/tirzepatide_doses?user_id=eq.${userId}&select=injected_at&order=injected_at.desc&limit=1`);
  const last = (data as any[])?.[0];
  if (!last) return false;
  const lastDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(last.injected_at));
  return lastDay !== todayStr && todayStr >= addDays(lastDay, 7);
}

async function peptideDueToday(userId: string, todayStr: string) {
  const { data } = await sbFetch(`/rest/v1/peptide_protocols?user_id=eq.${userId}&is_active=eq.true&select=id,start_date,phases`);
  for (const p of (data as any[]) || []) {
    const day = Math.round((Date.parse(todayStr) - Date.parse(p.start_date)) / 86400000) + 1;
    if (!(p.phases || []).some((ph: any) => day >= ph.day_start && day <= ph.day_end)) continue;
    const { data: doses } = await sbFetch(`/rest/v1/peptide_doses?protocol_id=eq.${p.id}&injected_at=gte.${todayStr}&select=id&limit=1`);
    if (!(doses as any[])?.length) return true;
  }
  return false;
}

async function morningBriefing(userId: string, profile: any, prefs: Record<string, any>, now: any, rules: any[]) {
  const today = now.dateStr;
  const { ctx, todayHealth, readings, weighedToday } = await buildContext(userId, profile, today, now.hour);
  const isGemma = userId === GEMMA_USER_ID;
  const extras: string[] = [];
  const pinned: string[] = [];

  // Sleep hasn't (fully) synced yet: never state a partial night as fact —
  // say what the evening snapshot and overnight glucose suggest instead.
  if (!Briefings.sleepSynced(todayHealth.sleep_total_hrs)) {
    delete ctx.sleep_hrs; delete ctx.sleep_perf; delete ctx.sleep_score;
    const partialHrs = Number(todayHealth.sleep_total_hrs) > 0 ? Number(todayHealth.sleep_total_hrs) : null;
    const { data: snaps } = await sbFetch(`/rest/v1/readiness_snapshots?user_id=eq.${userId}&snap_date=eq.${addDays(today, -1)}&select=battery,taken_at`);
    const snap = (snaps as any[])?.[0];
    const midnight = Briefings.londonMidnightMs(today);
    const phrase = Briefings.fallbackNightPhrase({
      partialHrs,
      snapshot: snap ? { battery: snap.battery, takenAt: snap.taken_at } : null,
      nightGlucose: Briefings.nightGlucoseSummary(readings, midnight, Math.min(Date.now(), midnight + 6 * 3600000)),
    });
    if (phrase) pinned.push(`${phrase}.`);
  }
  extras.push(...Briefings.morningExtras({
    weighinDue: prefs.weighin?.enabled !== false && Briefings.weighinDue({ isGemma, weekday: now.weekday, days: prefs.weighin?.days_of_week ?? null, loggedToday: weighedToday }),
    tirzepatideDue: !isGemma && prefs.tirzepatide?.enabled !== false && await tirzepatideDueToday(userId, today),
    peptideDue: !isGemma && prefs.peptide?.enabled !== false && await peptideDueToday(userId, today),
  }));
  return Briefings.composeBriefing(itemsFor(rules, ctx, 'morning'), { slot: 'morning', extras, pinned });
}

Deno.serve(async () => {
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });
  const now = londonNow();
  const nowMin = now.hour * 60 + now.minute;

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  const byUser: Record<string, any[]> = {};
  ((subs as any[]) || []).forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });
  const userIds = Object.keys(byUser);
  const result = { morning: { sent: 0, failed: 0, skipped: 0 }, evening: { sent: 0, failed: 0, skipped: 0 }, errors: [] as string[] };
  if (!userIds.length) return new Response(JSON.stringify(result));

  const [{ data: prefRows }, { data: profiles }] = await Promise.all([
    sbFetch(`/rest/v1/notification_prefs?notif_key=in.(morning_briefing,evening_briefing,weighin,tirzepatide,peptide,oral_meds)&select=user_id,notif_key,enabled,days_of_week`),
    sbFetch(`/rest/v1/profiles?id=in.(${userIds.join(',')})&select=id,age_years,sex,recovery_weights,briefing_schedule,diabetes_enabled,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min`),
  ]);
  const prefsByUser: Record<string, Record<string, any>> = {};
  ((prefRows as any[]) || []).forEach(p => { (prefsByUser[p.user_id] ||= {})[p.notif_key] = p; });
  const profileById: Record<string, any> = {};
  ((profiles as any[]) || []).forEach(p => { profileById[p.id] = p; });

  let rules: any[] | null = null;
  const loadRules = async () => rules ??= ((await sbFetch('/rest/v1/insight_rules?enabled=eq.true&select=id,category,severity,priority,conditions,title,body,headline,reason,action,slot')).data as any[]) || [];

  for (const userId of userIds) {
    const prefs = prefsByUser[userId] || {};
    const profile = profileById[userId] || {};
    const schedule = Briefings.scheduleFor(userId, profile.briefing_schedule);

    if (prefs.morning_briefing?.enabled !== false && Briefings.isDue(Briefings.morningTime(schedule, now.weekday), nowMin)) {
      try {
        if (await claim(userId, 'morning', now.dateStr)) {
          const b = await morningBriefing(userId, profile, prefs, now, await loadRules());
          const pushed = await sendToSubscriptions(byUser[userId], { title: b.title, body: b.body, url: '/', tag: 'briefing-morning' });
          result.morning.sent += pushed.sent; result.morning.failed += pushed.failed;
          await recordBody(userId, 'morning', now.dateStr, b.body);
        } else result.morning.skipped++;
      } catch (e) { result.errors.push(`morning ${userId.slice(0, 8)}: ${(e as Error).message}`); }
    }
  }
  if (result.errors.length) console.error('notify-briefings:', result.errors.join(' | '));
  return new Response(JSON.stringify(result));
});
