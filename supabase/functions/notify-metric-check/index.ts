// Scheduled: intended to be invoked every 15 minutes, always (no fixed
// self-gate hour — every user's own metric_alert_rules row carries its own
// check_hour/check_minute, so this has to run often enough to catch any of
// them). Generic engine behind the Notifications settings tab's "Custom
// metric alerts": any tracked metric, either direction (under/over target),
// user's own target/%/time/wording.
//
// Replaces notify-steps-check — that function's exact behaviour (12,000-step
// goal, notify if 25% under by 16:00) is just the default `steps` "under"
// rule here now, generalised rather than lost.

import { sendWebPush, londonNow } from '../_shared/webpush.ts';
import { computeRecoveryScore, computeSleepScore, computeStrainScoreTrimp } from '../_shared/health-scores.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const CHECK_MINUTE_TOLERANCE = 7; // ±window around a rule's chosen minute, safe for a 15-min-cadence cron

const METRIC_LABELS: Record<string, string> = {
  steps: 'steps', calories_consumed: 'calories', active_energy_kcal: 'active energy',
  exercise_mins: 'exercise minutes', sleep_total_hrs: 'sleep', hrv_ms: 'HRV', resting_hr: 'resting heart rate',
  weight_kg: 'weight', recovery_score: 'recovery score', sleep_score: 'sleep score', strain_score: 'strain score',
};
const METRIC_UNITS: Record<string, string> = {
  steps: '', calories_consumed: 'kcal', active_energy_kcal: 'kcal', exercise_mins: 'min',
  sleep_total_hrs: 'h', hrv_ms: 'ms', resting_hr: 'bpm', weight_kg: 'kg',
  recovery_score: '/100', sleep_score: '/100', strain_score: '/21',
};

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}
async function sbPatch(path: string, body: unknown) {
  await fetch(`${SB_URL}${path}`, {
    method: 'PATCH',
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Same precedence notify-ai-coach/app.js already use for "today's calories
// eaten" — kept identical so this alert never disagrees with the dashboard.
function consumedFor(dayLog: any, healthRow: any) {
  if (dayLog?.cal_fitl00p != null) return Number(dayLog.cal_fitl00p);
  if (dayLog?.cal_mfp != null) return Number(dayLog.cal_mfp);
  if (healthRow?.dietary_energy_kcal != null) return Number(healthRow.dietary_energy_kcal);
  if (dayLog?.cal_apple != null) return Number(dayLog.cal_apple);
  if (dayLog?.cal_total > 0) return Number(dayLog.cal_total);
  return null;
}

// Fetched once per user per run (not once per rule) — several rules can
// share the same underlying context (e.g. steps + calories both due at once).
async function fetchUserContext(userId: string, todayStr: string) {
  const historyStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [{ data: healthRows }, { data: profiles }, { data: dailyLogRows }, { data: foodLogRows }, { data: workouts }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${historyStart}&log_date=lte.${todayStr}&select=log_date,steps,active_energy_kcal,exercise_mins,sleep_total_hrs,hrv_ms,resting_hr,weight_kg,dietary_energy_kcal&order=log_date.asc`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=age_years,sex`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=eq.${todayStr}&select=weight,cal_total,cal_apple,cal_mfp`),
    sbFetch(`/rest/v1/food_log?user_id=eq.${userId}&log_date=eq.${todayStr}&select=calories_kcal`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${todayStr}T00:00:00Z&select=avg_heart_rate,started_at,ended_at,active_energy_kcal`),
  ]);
  const healthHistory = (healthRows as any[]) || [];
  const todayHealth = healthHistory.find((h: any) => h.log_date === todayStr) || {};
  const dayLog = (dailyLogRows as any[])?.[0] || {};
  const foodSum = ((foodLogRows as any[]) || []).reduce((s: number, r: any) => s + (Number(r.calories_kcal) || 0), 0);
  const profile = (profiles as any[])?.[0] || {};
  return { healthHistory, todayHealth, dayLog, foodSum, workouts: (workouts as any[]) || [], profile };
}

// Missing data → null, never fabricated — same "unknown ≠ behind" posture
// notify-steps-check already documented for itself.
function getMetricValue(metricKey: string, ctx: any): number | null {
  switch (metricKey) {
    case 'steps': return ctx.todayHealth.steps ?? null;
    case 'active_energy_kcal': return ctx.todayHealth.active_energy_kcal ?? null;
    case 'exercise_mins': return ctx.todayHealth.exercise_mins ?? null;
    case 'sleep_total_hrs': return ctx.todayHealth.sleep_total_hrs ?? null;
    case 'hrv_ms': return ctx.todayHealth.hrv_ms ?? null;
    case 'resting_hr': return ctx.todayHealth.resting_hr ?? null;
    case 'weight_kg':
      if (ctx.dayLog.weight != null) return Number(ctx.dayLog.weight);
      return ctx.todayHealth.weight_kg ?? null;
    case 'calories_consumed': {
      const log = { ...ctx.dayLog, cal_fitl00p: ctx.foodSum || null };
      return consumedFor(log, ctx.todayHealth);
    }
    case 'recovery_score':
      return computeRecoveryScore(ctx.todayHealth, ctx.healthHistory).score;
    case 'sleep_score':
      return computeSleepScore(ctx.todayHealth, ctx.healthHistory).score;
    case 'strain_score':
      return computeStrainScoreTrimp(ctx.todayHealth, ctx.dayLog, ctx.workouts, ctx.profile.age_years, ctx.profile.sex === 'female').score;
    default:
      return null;
  }
}

function renderMessage(rule: any, value: number, pct: number) {
  const label = METRIC_LABELS[rule.metric_key] || rule.metric_key;
  const unit = METRIC_UNITS[rule.metric_key] || '';
  const template = rule.message_template && rule.message_template.trim()
    ? rule.message_template
    : `Your ${label} was {value}{unit} today — {pct}% ${rule.direction} your {target}{unit} target.`;
  return template
    .replace(/\{value\}/g, String(Math.round(value * 10) / 10))
    .replace(/\{target\}/g, String(rule.target_value))
    .replace(/\{pct\}/g, String(Math.round(Math.abs(pct))))
    .replace(/\{unit\}/g, unit);
}

Deno.serve(async () => {
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });
  const now = londonNow();
  const nowMinutesTotal = now.hour * 60 + now.minute;
  const todayStr = now.dateStr;

  const { data: ruleRows } = await sbFetch('/rest/v1/metric_alert_rules?enabled=eq.true&select=*');
  const rules = (ruleRows as any[]) || [];
  if (!rules.length) return new Response('no active rules');

  const due = rules.filter(r => {
    if (r.last_sent_date === todayStr) return false;
    if (r.check_hour == null) return false;
    const ruleMinutesTotal = r.check_hour * 60 + (r.check_minute || 0);
    return Math.abs(nowMinutesTotal - ruleMinutesTotal) <= CHECK_MINUTE_TOLERANCE;
  });
  if (!due.length) return new Response('no rules due');

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  const subsByUser: Record<string, any[]> = {};
  ((subs as any[]) || []).forEach(s => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const dueByUser: Record<string, any[]> = {};
  due.forEach(r => { (dueByUser[r.user_id] = dueByUser[r.user_id] || []).push(r); });

  let sent = 0, failed = 0, triggered = 0, skipped = 0;

  for (const [userId, userRules] of Object.entries(dueByUser)) {
    const userSubs = subsByUser[userId];
    if (!userSubs?.length) { skipped += userRules.length; continue; }

    const ctx = await fetchUserContext(userId, todayStr);

    for (const rule of userRules) {
      const value = getMetricValue(rule.metric_key, ctx);
      if (value == null || !rule.target_value) { skipped++; continue; }

      const pct = ((value - rule.target_value) / rule.target_value) * 100;
      const thresholdPct = Number(rule.threshold_pct) || 0;
      const fires = rule.direction === 'under' ? pct <= -thresholdPct : pct >= thresholdPct;
      if (!fires) { skipped++; continue; }

      triggered++;
      const body = renderMessage(rule, value, pct);
      const payload = { title: '📊 Metric alert', body, url: '/', tag: `metric-alert-${rule.metric_key}-${rule.direction}` };
      let anySent = false;
      for (const s of userSubs) {
        try {
          const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
          if (r.status >= 200 && r.status < 300) { sent++; anySent = true; } else failed++;
        } catch { failed++; }
      }
      if (anySent) await sbPatch(`/rest/v1/metric_alert_rules?id=eq.${rule.id}`, { last_sent_date: todayStr });
    }
  }

  return new Response(JSON.stringify({ triggered, sent, failed, skipped }));
});
