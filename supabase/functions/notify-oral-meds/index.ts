// Scheduled: fires at both UTC equivalents of 21:00 Europe/London and
// exits unless it's actually 21:00 local right now (see londonNow() in
// _shared/webpush.ts). One check a day, no repeat-until-logged loop like
// notify-peptide.js — an ordinary daily pill isn't time-critical the way
// insulin/peptide dosing is, so a single evening nudge is enough.
//
// Reads oral_meds (whatever active pills exist for the account — no
// hardcoded finasteride/minoxidil names, so adding a third med later is
// a data change, not a new function) and checks oral_med_doses for today
// against each. Everything still missing gets bundled into one
// notification per person rather than one push per pill.
//
// Ported from src/netlify/functions/notify-oral-meds.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendWebPush, londonNow } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_KEY');

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 21) return new Response('not 21:00 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: meds } = await sbFetch('/rest/v1/oral_meds?is_active=eq.true&select=id,user_id,name,dose_mg');
  if (!meds?.length) return new Response('no active oral meds');

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');
  const subsByUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const dayStart = `${now.dateStr}T00:00:00Z`;
  const { data: takenToday } = await sbFetch(`/rest/v1/oral_med_doses?taken_at=gte.${dayStart}&select=med_id`);
  const takenMedIds = new Set((takenToday || []).map((d: any) => d.med_id));

  const medsByUser: Record<string, any[]> = {};
  meds.filter((m: any) => !takenMedIds.has(m.id)).forEach((m: any) => { (medsByUser[m.user_id] = medsByUser[m.user_id] || []).push(m); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, missing] of Object.entries(medsByUser)) {
    const userSubs = subsByUser[userId];
    if (!userSubs?.length) { skipped++; continue; }

    const body = missing.length === 1
      ? `Don't forget your ${missing[0].name} ${missing[0].dose_mg}mg today.`
      : `Don't forget today's meds: ${missing.map((m: any) => `${m.name} ${m.dose_mg}mg`).join(', ')}.`;
    const payload = { title: '💊 Evening meds', body, url: '/', tag: 'oral-meds-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
