// netlify/functions/notify-tirzepatide.js
// Scheduled: cron fires hourly (covering both UTC equivalents of the
// BST/GMT offset) across the window that spans Friday 09:00-21:00
// Europe/London, and self-gates on every fire to only actually proceed
// when it's really Friday and really within that local hour range (see
// londonNow() in _lib/webpush.js). Keeps re-firing every hour until an
// injection has been logged for today, then goes quiet for the rest of
// the day.

const { sendWebPush, londonNow, londonDateStrOf, GEMMA_USER_ID } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR   = 21; // last hour this still fires on

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

// Same two-phase absorption/elimination model as the dashboard's
// Tirzepatide chart (app.js) — ported here so the notification can
// state a real current-level number instead of just "last dose was X".
const TZ_KE_PER_HOUR = Math.log(2) / 120; // 5-day terminal half-life
const TZ_KA_PER_HOUR = 0.05125785820006391; // solved so Tmax = 48h
const TZ_PEAK_HOURS = 48;
function tzDoseShape(hoursSince) {
  if (hoursSince < 0) return 0;
  return Math.exp(-TZ_KE_PER_HOUR * hoursSince) - Math.exp(-TZ_KA_PER_HOUR * hoursSince);
}
const TZ_SHAPE_AT_PEAK = tzDoseShape(TZ_PEAK_HOURS);
function tzLevelAt(doses, atMs) {
  let total = 0;
  for (const d of doses) {
    const hoursSince = (atMs - d.injectedMs) / 3600000;
    if (hoursSince < 0) continue;
    total += d.doseMg * (tzDoseShape(hoursSince) / TZ_SHAPE_AT_PEAK);
  }
  return total;
}

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

async function buildReminder(userId, todayDateStr) {
  const { data } = await sbFetch(`/rest/v1/tirzepatide_doses?user_id=eq.${userId}&select=dose_mg,site,injected_at&order=injected_at.desc&limit=30`);
  const doses = data || [];
  if (!doses.length) return 'Time for your Tirzepatide injection — log today’s dose in fitl00p.';

  const alreadyLoggedToday = doses.some(d => londonDateStrOf(d.injected_at) === todayDateStr);
  if (alreadyLoggedToday) return null;

  const last = doses[0];
  const next = tzNextSite(last.site);
  const lastLabel = TZ_SITE_LABELS[last.site] || last.site || 'unknown site';
  const nextLabel = TZ_SITE_LABELS[next] || next;

  const level = tzLevelAt(
    doses.map(d => ({ doseMg: Number(d.dose_mg), injectedMs: new Date(d.injected_at).getTime() })),
    Date.now()
  );

  return `Last dose ${last.dose_mg}mg (${lastLabel}), current level ~${level.toFixed(1)}mg. Try ${nextLabel} this time.`;
}

exports.handler = async function () {
  const now = londonNow();
  const inWindow = now.weekday === 'Fri' && now.hour >= WINDOW_START_HOUR && now.hour <= WINDOW_END_HOUR;
  if (!inWindow) return { statusCode: 200, body: 'not Friday 09:00-21:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    if (userId === GEMMA_USER_ID) { skipped++; continue; } // doesn't use Tirzepatide
    const body = await buildReminder(userId, now.dateStr);
    if (!body) { skipped++; continue; }
    const payload = { title: '💉', body, url: '/', tag: 'tirzepatide-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
