// netlify/functions/notify-tirzepatide.js
// Scheduled: fires at both UTC equivalents of Friday 09:10 Europe/London
// and exits unless it's actually Friday 09:10 local right now (see
// londonNow() in _lib/webpush.js). Reminds each subscribed user to take
// their weekly Tirzepatide injection, suggesting the next site in the
// same rotation the app itself defaults to.

const { sendWebPush, londonNow } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const TZ_SITE_LABELS = {
  left_thigh: 'left thigh', right_thigh: 'right thigh',
  left_stomach: 'left stomach', right_stomach: 'right stomach',
  centre_stomach: 'centre stomach',
};
const TZ_SITE_ORDER = ['left_thigh', 'right_thigh', 'left_stomach', 'right_stomach', 'centre_stomach'];
function tzNextSite(lastSite) {
  const idx = TZ_SITE_ORDER.indexOf(lastSite);
  return TZ_SITE_ORDER[(idx + 1) % TZ_SITE_ORDER.length];
}

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

async function buildReminder(userId) {
  const { data } = await sbFetch(`/rest/v1/tirzepatide_doses?user_id=eq.${userId}&select=dose_mg,site&order=injected_at.desc&limit=1`);
  const last = data?.[0];
  if (!last) return 'Time for your Tirzepatide injection 💉 — log today’s dose in fitl00p.';

  const next = tzNextSite(last.site);
  const lastLabel = TZ_SITE_LABELS[last.site] || last.site || 'unknown site';
  const nextLabel = TZ_SITE_LABELS[next] || next;
  return `Time for your Tirzepatide injection 💉 — last dose ${last.dose_mg}mg (${lastLabel}). Try ${nextLabel} this time.`;
}

exports.handler = async function () {
  const now = londonNow();
  if (now.weekday !== 'Fri' || now.hour !== 9) return { statusCode: 200, body: 'not Friday 09:xx London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const body = await buildReminder(userId);
    const payload = { title: 'Tirzepatide reminder', body, url: '/', tag: 'tirzepatide-reminder' };
    for (const s of userSubs) {
      try {
        await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        sent++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
