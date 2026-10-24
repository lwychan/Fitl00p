// Scheduled: fires at both the summer and winter UTC equivalents of 07:00
// Europe/London (see londonNow() in _shared/webpush.ts for why), and
// exits immediately unless it's the person's chosen hour right now. Sends
// the morning readiness summary: Recovery and Sleep as of this morning,
// yesterday's Strain (0-21, same as the dashboard), then the top two
// matching insight rules (public.insight_rules, matched with the same
// src/insights.js the app uses) — the old AI coach briefing, without AI.
// Body Battery and glucose rules need on-phone data, so they only ever
// show in the app.

import { sendToSubscriptions, sbFetch, londonNow } from '../_shared/webpush.ts';
import { computeRecoveryScore, computeSleepScore, computeStrainScoreTrimp, computeSleepNeed, loadSuggestion } from '../_shared/health-scores.ts';
import ReadinessModel from '../_shared/readiness-model.js';
import Insights from '../_shared/insights.js';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ICONS: Record<string, string> = { good: '✅', info: '💡', caution: '⚠️', warn: '🛑' };

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Same SD-based z-score the app uses (bbZScore in app.js).
function zScore(hist: any[], field: string, date: string, value: any, log: boolean, floor: number) {
  const stats = ReadinessModel.personalBaseline(hist, field, date, { log });
  if (!stats || value == null || (log && !(value > 0))) return null;
  return ((log ? Math.log(value) : Number(value)) - stats.mean) / Math.max(stats.sd, floor);
}

async function buildSummary(userId: string, todayStr: string, yesterdayStr: string, rules: any[]) {
  const windowStart = addDays(todayStr, -40);
  const [{ data: healthRows }, { data: profileRows }, { data: workoutRows }, { data: maxRows }, { data: foodRows }, { data: logRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${windowStart}&log_date=lte.${todayStr}&select=log_date,hrv_ms,resting_hr,respiratory_rate,wrist_temp_dev,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,resting_energy_kcal,dietary_energy_kcal,weight_kg,steps&order=log_date.asc`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=age_years,sex,recovery_weights`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${addDays(todayStr, -8)}T00:00:00Z&select=workout_type,avg_heart_rate,started_at,ended_at,active_energy_kcal&order=started_at.desc`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${addDays(todayStr, -180)}T00:00:00Z&max_heart_rate=not.is.null&select=max_heart_rate&order=max_heart_rate.desc&limit=2`),
    sbFetch(`/rest/v1/food_log?user_id=eq.${userId}&log_date=gte.${addDays(todayStr, -8)}&select=log_date,calories_kcal`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=gte.${addDays(todayStr, -15)}&select=log_date,weight,cal_mfp`),
  ]);

  const profile = (profileRows as any[])?.[0] || {};
  const workouts = (workoutRows as any[]) || [];
  const logs = (logRows as any[]) || [];
  // Merge fitl00p food totals and MFP into the health rows, as the app does.
  const food: Record<string, number> = {};
  ((foodRows as any[]) || []).forEach(r => { food[r.log_date] = (food[r.log_date] || 0) + (Number(r.calories_kcal) || 0); });
  const mfp: Record<string, number> = {};
  logs.forEach(l => { if (l.cal_mfp != null) mfp[l.log_date] = Number(l.cal_mfp); });
  const health = ((healthRows as any[]) || []).map(h => ({ ...h, cal_fitl00p: food[h.log_date] ?? null, cal_mfp: mfp[h.log_date] ?? null }));

  const todayHealth     = health.find((h: any) => h.log_date === todayStr) || {};
  const yesterdayHealth = health.find((h: any) => h.log_date === yesterdayStr) || null;
  const yesterdayWorkouts = workouts.filter(w => w.started_at >= `${yesterdayStr}T00:00:00` && w.started_at < `${todayStr}T00:00:00`);

  const recovery = computeRecoveryScore(todayHealth, health, profile.recovery_weights ?? null);
  const sleep    = computeSleepScore(todayHealth, health);
  const strain   = computeStrainScoreTrimp(yesterdayHealth, null, yesterdayWorkouts, profile.age_years, profile.sex === 'female', (maxRows as any[])?.[1]?.max_heart_rate ?? null);

  const scoreParts: string[] = [];
  if (recovery.score != null) scoreParts.push(`Recovery ${recovery.score}`);
  if (sleep.score != null)    scoreParts.push(`Sleep ${sleep.score}`);
  if (strain.score != null)   scoreParts.push(`Strain ${strain.score} yesterday`);
  if (!scoreParts.length) return null;

  // Context for the insight rules — the subset the server can know.
  const need = computeSleepNeed(health, todayStr, strain.score);
  const lastNight = computeSleepNeed(health, todayStr, null);
  const ctx: Record<string, any> = { hour: 7 };
  if (recovery.score != null) {
    ctx.recovery = recovery.score;
    ctx.strain_target_lo = recovery.score >= 67 ? 14 : recovery.score >= 34 ? 9 : 0;
    ctx.strain_target_hi = recovery.score >= 67 ? 18 : recovery.score >= 34 ? 13.5 : 8;
  }
  if (sleep.score != null) ctx.sleep_score = sleep.score;
  if (todayHealth.sleep_total_hrs != null) {
    ctx.sleep_hrs = Number(todayHealth.sleep_total_hrs);
    ctx.sleep_perf = Math.round((ctx.sleep_hrs / lastNight.needHours) * 100);
  }
  ctx.sleep_need = need.needHours;
  ctx.sleep_debt = need.debtHours;
  ctx.hrv_z = zScore(health, 'hrv_ms', todayStr, todayHealth.hrv_ms, true, 0.05);
  ctx.rhr_z = zScore(health, 'resting_hr', todayStr, todayHealth.resting_hr, false, 1);
  ctx.rr_z = zScore(health, 'respiratory_rate', todayStr, todayHealth.respiratory_rate, false, 0.25);
  if (todayHealth.wrist_temp_dev != null) ctx.wrist_temp = Number(todayHealth.wrist_temp_dev);
  if (strain.score != null) ctx.strain_yday = strain.score;
  Object.assign(ctx, Insights.healthTrendMetrics(health, todayStr));
  Object.assign(ctx, Insights.dailyContextMetrics({
    day: todayStr, nowMs: Date.now(), history: health,
    weights: logs.filter(l => l.weight != null), workouts, hasPlan: false,
  }));
  delete ctx.has_plan; // unknown here — keeps plan-only rules out of the push
  for (const k of Object.keys(ctx)) if (ctx[k] == null || Number.isNaN(ctx[k])) delete ctx[k];

  const insights = Insights.evaluateInsights(rules, ctx, { max: 2 });
  let body = scoreParts.join(' · ');
  if (insights.length) {
    body += '\n' + insights.map((i: any) => `${ICONS[i.severity] || '💡'} ${i.title}`).join('\n');
  } else {
    const load = loadSuggestion(recovery.score);
    if (load) body += `\nSuggested load: ${load.word} — ${load.reason}.`;
  }
  return body;
}

Deno.serve(async () => {
  const now = londonNow();
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const yesterday = addDays(now.dateStr, -1);

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');

  const byUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  // notif_key 'daily_summary' — per-user hour, default 07:00 London (see notification_prefs).
  const { data: prefsRows } = await sbFetch(`/rest/v1/notification_prefs?notif_key=eq.daily_summary&select=user_id,enabled,check_hour`);
  const prefsByUser: Record<string, any> = {};
  ((prefsRows as any[]) || []).forEach(p => { prefsByUser[p.user_id] = p; });

  let rules: any[] | null = null;
  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const prefs = prefsByUser[userId];
    if (prefs?.enabled === false) { skipped++; continue; }
    if (now.hour !== (prefs?.check_hour ?? 7)) { skipped++; continue; }

    rules ??= ((await sbFetch('/rest/v1/insight_rules?enabled=eq.true&select=id,category,severity,priority,conditions,title,body')).data as any[]) || [];
    const body = await buildSummary(userId, now.dateStr, yesterday, rules);
    if (!body) continue;
    const payload = { title: '⚡ Today’s Readiness', body, url: '/', tag: 'daily-summary' };
    const pushed = await sendToSubscriptions(userSubs, payload);
    sent += pushed.sent; failed += pushed.failed;
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
