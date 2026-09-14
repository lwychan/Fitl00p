// netlify/functions/notify-oral-meds.js
// Scheduled: fires at both UTC equivalents of 21:00 Europe/London and
// exits unless it's actually 21:00 local right now (see londonNow() in
// _lib/webpush.js). One check a day, no repeat-until-logged loop like
// notify-peptide.js — an ordinary daily pill isn't time-critical the
// way insulin/peptide dosing is, so a single evening nudge is enough.
//
// Reads oral_meds (whatever active pills exist for the account — no
// hardcoded finasteride/minoxidil names, so adding a third med later is
// a data change, not a new function) and checks oral_med_doses for
// today against each. Everything still missing gets bundled into one
// notification per person rather than one push per pill.

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

exports.handler = async function () {
  const now = londonNow();
  if (now.hour !== 21) return { statusCode: 200, body: 'not 21:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const { data: meds } = await sbFetch('/rest/v1/oral_meds?is_active=eq.true&select=id,user_id,name,dose_mg');
  if (!meds?.length) return { statusCode: 200, body: 'no active oral meds' };

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };
  const subsByUser = {};
  subs.forEach(s => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const dayStart = `${now.dateStr}T00:00:00Z`;
  const { data: takenToday } = await sbFetch(`/rest/v1/oral_med_doses?taken_at=gte.${dayStart}&select=med_id`);
  const takenMedIds = new Set((takenToday || []).map(d => d.med_id));

  const medsByUser = {};
  meds.filter(m => !takenMedIds.has(m.id)).forEach(m => { (medsByUser[m.user_id] = medsByUser[m.user_id] || []).push(m); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, missing] of Object.entries(medsByUser)) {
    const userSubs = subsByUser[userId];
    if (!userSubs?.length) { skipped++; continue; }

    const body = missing.length === 1
      ? `Don't forget your ${missing[0].name} ${missing[0].dose_mg}mg today.`
      : `Don't forget today's meds: ${missing.map(m => `${m.name} ${m.dose_mg}mg`).join(', ')}.`;
    const payload = { title: '💊 Evening meds', body, url: '/', tag: 'oral-meds-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return { statusCode: 200, body: JSON.stringify({ sent, failed, skipped }) };
};
