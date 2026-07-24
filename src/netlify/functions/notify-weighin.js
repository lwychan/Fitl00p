// netlify/functions/notify-weighin.js
// Scheduled: cron fires hourly (covering both UTC equivalents of the
// BST/GMT offset) across the window that spans Tuesday 10:00-21:00
// Europe/London, and self-gates on every fire to only actually proceed
// when it's really Tuesday and really within that local hour range (see
// londonNow() in _lib/webpush.js). First check is effectively ~10:10 —
// keeps re-firing every hour after that until a weight has been logged
// for today (from either MFP-synced health_daily or a manual log entry),
// then goes quiet for the rest of the day.

const { sendWebPush, londonNow, GEMMA_USER_ID } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const WINDOW_START_HOUR = 10;
const WINDOW_END_HOUR   = 21; // last hour this still fires on

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

async function buildReminder(userId, todayDateStr) {
  const [{ data: todayHealthRows }, { data: todayLogRows }, { data: planRows }, { data: healthRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=eq.${todayDateStr}&weight_kg=not.is.null&select=weight_kg`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=eq.${todayDateStr}&weight=not.is.null&select=weight`),
    sbFetch(`/rest/v1/weight_plans?user_id=eq.${userId}&is_active=eq.true&select=target_weight&order=created_at.desc&limit=1`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&weight_kg=not.is.null&select=weight_kg&order=log_date.desc&limit=1`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=weight_unit`),
  ]);

  const alreadyLoggedToday = (todayHealthRows?.length || 0) > 0 || (todayLogRows?.length || 0) > 0;
  if (alreadyLoggedToday) return null;

  const base = 'Tuesday weigh-in reminder ⚖️ — pop on the scale and log it in fitl00p.';

  const plan   = planRows?.[0];
  const latest = healthRows?.[0]?.weight_kg != null ? Number(healthRows[0].weight_kg) : null;
  const unit   = profileRows?.[0]?.weight_unit || 'kg';
  if (!plan || latest == null) return base;

  const toGo = latest - Number(plan.target_weight);
  if (Math.abs(toGo) < 0.05) return `${base} You’re right at your ${plan.target_weight}${unit} goal.`;
  return `${base} ${toGo.toFixed(1)}${unit} to your ${plan.target_weight}${unit} goal.`;
}

exports.handler = async function () {
  const now = londonNow();
  const inWindow = now.weekday === 'Tue' && now.hour >= WINDOW_START_HOUR && now.hour <= WINDOW_END_HOUR;
  if (!inWindow) return { statusCode: 200, body: 'not Tuesday 10:00-21:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    if (userId === GEMMA_USER_ID) { skipped++; continue; } // has her own daily reminder — see notify-weighin-gemma.js
    const body = await buildReminder(userId, now.dateStr);
    if (!body) { skipped++; continue; }
    const payload = { title: 'Weigh-in day', body, url: '/', tag: 'weighin-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
