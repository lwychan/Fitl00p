// netlify/functions/notify-bpc157.js
// Scheduled: cron fires hourly (covering both UTC equivalents of the
// BST/GMT offset) across the window that spans 07:30-21:30 Europe/London,
// every day (unlike Tirzepatide, which is weekly). Keeps re-firing every
// hour until a BPC-157 injection has been logged for today, then goes
// quiet for the rest of the day. See notify-tirzepatide.js — same
// pattern, daily cadence instead of weekly.

const { sendWebPush, londonNow, londonDateStrOf, GEMMA_USER_ID } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const WINDOW_START_HOUR = 7; // 07:30 first fire (minute fixed by the cron schedule itself)
const WINDOW_END_HOUR   = 21; // last hour this still fires on

const BPC_SITE_LABELS = {
  left_thigh: 'left thigh', right_thigh: 'right thigh',
  left_stomach: 'left stomach', right_stomach: 'right stomach',
  centre_stomach: 'centre stomach',
};
const BPC_SITE_ORDER = ['left_thigh', 'right_thigh', 'left_stomach', 'right_stomach', 'centre_stomach'];
function bpcNextSite(lastSite) {
  const idx = BPC_SITE_ORDER.indexOf(lastSite);
  return BPC_SITE_ORDER[(idx + 1) % BPC_SITE_ORDER.length];
}

// Same two-phase absorption/elimination model as the History tab's
// BPC-157 chart (app.js) — ported here so the notification can state a
// real current-level number instead of just "last dose was X". See the
// big comment above BPC_KE_PER_HOUR in app.js for why these particular
// constants: community-estimated ~4h half-life, ~30min time-to-peak —
// there's no rigorous published human PK study for BPC-157 to draw on.
const BPC_KE_PER_HOUR = Math.log(2) / 4;
const BPC_KA_PER_HOUR = 7.782710769449455; // solved so Tmax = 0.5h
function bpcDoseShape(hoursSince) {
  if (hoursSince < 0) return 0;
  return Math.exp(-BPC_KE_PER_HOUR * hoursSince) - Math.exp(-BPC_KA_PER_HOUR * hoursSince);
}
const BPC_SHAPE_AT_PEAK = bpcDoseShape(0.5);
function bpcLevelAt(doses, atMs) {
  let total = 0;
  for (const d of doses) {
    const hoursSince = (atMs - d.injectedMs) / 3600000;
    if (hoursSince < 0) continue;
    total += d.doseMg * (bpcDoseShape(hoursSince) / BPC_SHAPE_AT_PEAK);
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
  const { data } = await sbFetch(`/rest/v1/bpc157_doses?user_id=eq.${userId}&select=dose_mg,site,injected_at&order=injected_at.desc&limit=30`);
  const doses = data || [];
  if (!doses.length) return null; // never started a course — nothing to remind about

  const alreadyLoggedToday = doses.some(d => londonDateStrOf(d.injected_at) === todayDateStr);
  if (alreadyLoggedToday) return null;

  const last = doses[0];
  const next = bpcNextSite(last.site);
  const lastLabel = BPC_SITE_LABELS[last.site] || last.site || 'unknown site';
  const nextLabel = BPC_SITE_LABELS[next] || next;

  const level = bpcLevelAt(
    doses.map(d => ({ doseMg: Number(d.dose_mg), injectedMs: new Date(d.injected_at).getTime() })),
    Date.now()
  );

  return `Last dose ${last.dose_mg}mg (${lastLabel}), current level ~${level.toFixed(2)}mg. Try ${nextLabel} this time.`;
}

exports.handler = async function () {
  const now = londonNow();
  const inWindow = now.hour >= WINDOW_START_HOUR && now.hour <= WINDOW_END_HOUR;
  if (!inWindow) return { statusCode: 200, body: 'not 07:30-21:30 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    if (userId === GEMMA_USER_ID) { skipped++; continue; } // doesn't use BPC-157
    const body = await buildReminder(userId, now.dateStr);
    if (!body) { skipped++; continue; }
    const payload = { title: '💉', body, url: '/', tag: 'bpc157-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
