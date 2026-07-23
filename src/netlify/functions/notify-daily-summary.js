// netlify/functions/notify-daily-summary.js
// Scheduled: fires at both the summer and winter UTC equivalents of
// 07:00 Europe/London (see londonNow() in _lib/webpush.js for why), and
// exits immediately unless it's actually 07:00 local right now. Sends
// every subscribed user a one-line summary of yesterday's steps,
// calories eaten, and weight, each compared to their own trailing
// 7-day average.

const { sendWebPush, londonNow } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDelta(diff, decimals) {
  if (diff == null || !isFinite(diff) || Math.abs(diff) < 0.05) return null;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(decimals)} vs 7d avg`;
}

async function buildSummary(userId, yesterday) {
  const weekAgo = addDays(yesterday, -6); // 7-day window ending yesterday inclusive

  const [{ data: healthRows }, { data: logRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${weekAgo}&log_date=lte.${yesterday}&select=log_date,steps,dietary_energy_kcal,weight_kg&order=log_date.asc`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=gte.${weekAgo}&log_date=lte.${yesterday}&select=log_date,weight,steps,cal_total,cal_apple&order=log_date.asc`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=weight_unit`),
  ]);

  const unit = profileRows?.[0]?.weight_unit || 'kg';
  const health = healthRows || [];
  const logs   = logRows   || [];

  const merged = {};
  for (const d of [...health, ...logs].map(r => r.log_date)) merged[d] = merged[d] || {};
  health.forEach(r => {
    const m = merged[r.log_date];
    if (r.steps != null) m.steps = r.steps;
    if (r.dietary_energy_kcal != null) m.cals = r.dietary_energy_kcal;
    if (r.weight_kg != null) m.weight = Number(r.weight_kg);
  });
  logs.forEach(r => {
    const m = merged[r.log_date];
    if (m.steps  == null && r.steps != null) m.steps = r.steps;
    if (m.cals   == null) m.cals = r.cal_apple ?? (r.cal_total > 0 ? r.cal_total : null);
    if (m.weight == null && r.weight != null) m.weight = Number(r.weight);
  });

  const y = merged[yesterday] || {};
  if (y.steps == null && y.cals == null && y.weight == null) return null;

  const priorDates = Object.keys(merged).filter(d => d !== yesterday);
  const avg = field => {
    const vals = priorDates.map(d => merged[d][field]).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const stepsAvg  = avg('steps');
  const weightAvg = avg('weight');

  const parts = [];
  if (y.steps != null) {
    const d = stepsAvg != null ? fmtDelta(y.steps - stepsAvg, 0) : null;
    parts.push(`${y.steps.toLocaleString()} steps${d ? ` (${d})` : ''}`);
  }
  if (y.cals != null) parts.push(`${Math.round(y.cals).toLocaleString()} kcal eaten`);
  if (y.weight != null) {
    const d = weightAvg != null ? fmtDelta(y.weight - weightAvg, 1) : null;
    parts.push(`${y.weight.toFixed(1)}${unit}${d ? ` (${d}${unit})` : ''}`);
  }

  if (!parts.length) return null;
  return `Yesterday: ${parts.join(', ')}.`;
}

exports.handler = async function () {
  const now = londonNow();
  if (now.hour !== 7) return { statusCode: 200, body: 'not 07:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const yesterday = addDays(now.dateStr, -1);

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const body = await buildSummary(userId, yesterday);
    if (!body) continue;
    const payload = { title: 'Yesterday’s progress', body, url: '/', tag: 'daily-summary' };
    for (const s of userSubs) {
      try {
        await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        sent++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
