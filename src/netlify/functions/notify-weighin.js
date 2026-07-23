// netlify/functions/notify-weighin.js
// Scheduled: fires at both UTC equivalents of Tuesday 09:10 Europe/London
// and exits unless it's actually Tuesday 09:10 local right now (see
// londonNow() in _lib/webpush.js). Reminds each subscribed user to weigh
// in, adding progress-to-target context when an active weight plan exists.

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

async function buildReminder(userId) {
  const base = 'Tuesday weigh-in reminder ⚖️ — pop on the scale and log it in fitl00p.';

  const [{ data: planRows }, { data: healthRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/weight_plans?user_id=eq.${userId}&is_active=eq.true&select=target_weight&order=created_at.desc&limit=1`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&weight_kg=not.is.null&select=weight_kg&order=log_date.desc&limit=1`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=weight_unit`),
  ]);

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
  if (now.weekday !== 'Tue' || now.hour !== 9) return { statusCode: 200, body: 'not Tuesday 09:xx London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const body = await buildReminder(userId);
    const payload = { title: 'Weigh-in day', body, url: '/', tag: 'weighin-reminder' };
    for (const s of userSubs) {
      try {
        await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        sent++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
