// Scheduled hourly; acts only at 21:00 Europe/London. The evening briefing
// already lists any meds not yet logged, so this separate push only goes
// when that briefing went out EARLIER and they're still not logged — or when
// the person has the evening briefing switched off (Briefings.medsPushDue).
// If the evening briefing is due after 21:00, it carries the meds instead.
// At most once a day (briefing_log 'meds').
//
// Reads oral_meds (whatever active pills exist for the account — adding a
// third med is a data change, not a new function) and checks oral_med_doses
// for today against each. Everything still missing is bundled into one push.

import { sendToSubscriptions, sbFetch, londonNow } from '../_shared/webpush.ts';
import { claim, recordBody, sentKinds } from '../_shared/briefing-log.ts';
import Briefings from '../_shared/briefings.js';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async () => {
  const now = londonNow();
  const nowMin = now.hour * 60 + now.minute;
  if (!Briefings.isDue(1260, nowMin)) return new Response('not 21:00 London');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: meds } = await sbFetch('/rest/v1/oral_meds?is_active=eq.true&select=id,user_id,name,dose_mg');
  if (!meds?.length) return new Response('no active oral meds');

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');
  const subsByUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const dayStart = new Date(Briefings.londonMidnightMs(now.dateStr)).toISOString();
  const { data: takenToday } = await sbFetch(`/rest/v1/oral_med_doses?taken_at=gte.${dayStart}&select=med_id`);
  const takenMedIds = new Set((takenToday || []).map((d: any) => d.med_id));

  const medsByUser: Record<string, any[]> = {};
  meds.filter((m: any) => !takenMedIds.has(m.id)).forEach((m: any) => { (medsByUser[m.user_id] = medsByUser[m.user_id] || []).push(m); });

  const { data: prefsRows } = await sbFetch(`/rest/v1/notification_prefs?notif_key=in.(oral_meds,evening_briefing)&select=user_id,notif_key,enabled`);
  const prefs: Record<string, Record<string, any>> = {};
  ((prefsRows as any[]) || []).forEach(p => { (prefs[p.user_id] ||= {})[p.notif_key] = p; });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, missing] of Object.entries(medsByUser)) {
    if (prefs[userId]?.oral_meds?.enabled === false) { skipped++; continue; }
    const userSubs = subsByUser[userId];
    if (!userSubs?.length) { skipped++; continue; }
    const kinds = await sentKinds(sbFetch, userId, now.dateStr);
    const due = Briefings.medsPushDue({ nowMin, pending: missing.length,
      eveningSent: kinds.includes('evening'), eveningEnabled: prefs[userId]?.evening_briefing?.enabled !== false });
    if (!due || kinds.includes('meds') || !(await claim(userId, 'meds', now.dateStr))) { skipped++; continue; }

    const body = missing.length === 1
      ? `Don't forget your ${missing[0].name} ${missing[0].dose_mg}mg today.`
      : `Don't forget today's meds: ${missing.map((m: any) => `${m.name} ${m.dose_mg}mg`).join(', ')}.`;
    const pushed = await sendToSubscriptions(userSubs, { title: '💊 Evening meds', body, url: '/', tag: 'oral-meds-reminder' });
    sent += pushed.sent; failed += pushed.failed;
    await recordBody(userId, 'meds', now.dateStr, body);
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
