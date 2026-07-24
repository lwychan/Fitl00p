// netlify/functions/notify-steps-check.js
// Scheduled: fires at both UTC equivalents of 16:00 Europe/London and
// exits unless it's actually 16:00 local right now (see londonNow() in
// _lib/webpush.js). Only sends a notification when today's step count is
// both known (synced) and under 9,000 — no data yet is treated as "don't
// know", not "behind", so it stays silent rather than false-alarming.

const { sendWebPush, londonNow } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
const STEP_THRESHOLD = 9000;
const STEP_GOAL      = 12000;

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

exports.handler = async function () {
  const now = londonNow();
  if (now.hour !== 16) return { statusCode: 200, body: 'not 16:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const { data: healthRows } = await sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=eq.${now.dateStr}&select=steps`);
    const steps = healthRows?.[0]?.steps;
    if (steps == null || steps >= STEP_THRESHOLD) { skipped++; continue; }

    const toGo = STEP_GOAL - steps;
    const payload = {
      title: 'Step goal check-in',
      body: `You’re at ${steps.toLocaleString()} steps today — ${toGo.toLocaleString()} to go to hit your ${STEP_GOAL.toLocaleString()} goal 🚶`,
      url: '/', tag: 'steps-check',
    };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
