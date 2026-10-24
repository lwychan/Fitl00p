// Scheduled every 15 min during 15:00-15:59 London (cron notify-peptide).
// The morning briefing says "Peptide dose today" and the evening briefing
// carries a last call; this sends ONE mid-afternoon nudge at 15:30
// (Briefings.PEPTIDE_NUDGE_MINUTE) if today's dose still isn't logged —
// at most once a day (briefing_log).
//
// Deliberately generic rather than hardcoded to one peptide: reads
// whatever peptide_protocols row is active for each user (name, start
// date, phase schedule) so switching protocols is a data change, not a
// new scheduled function.
//
// A protocol is marked inactive here once it's run past its LAST
// defined phase's day_end (see lastPhaseDay) — it naturally stops
// prompting once the course is actually finished, rather than needing a
// manual deactivation step. A day that simply falls in a gap between
// phases (e.g. a twice-weekly schedule's off days) is NOT the same
// thing and must not deactivate the protocol — currentPhase() returning
// null means either one, so the two are told apart explicitly below.
//
// Ported from src/netlify/functions/notify-peptide.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendToSubscriptions, sbFetch, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';
import { claim, recordBody, sentKinds } from '../_shared/briefing-log.ts';
import Briefings from '../_shared/briefings.js';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function sbPatch(path: string, body: unknown) {
  await fetch(`${SB_URL}${path}`, {
    method: 'PATCH',
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Day 1 = the protocol's own start_date (inclusive), matching how the
// app itself displays "Day N" — see peptideDayNumber in app.js.
function dayNumber(startDateStr: string, todayDateStr: string) {
  const start = new Date(startDateStr + 'T00:00:00Z');
  const today = new Date(todayDateStr + 'T00:00:00Z');
  return Math.round((today.getTime() - start.getTime()) / 86400000) + 1;
}

function currentPhase(phases: any[], day: number) {
  return phases.find(p => day >= p.day_start && day <= p.day_end) || null;
}

// The day after the last dose this protocol's phases ever define —
// matches peptideLastPhaseDay in app.js, which the client already uses
// to decide when a protocol is "Completed" independent of is_active.
function lastPhaseDay(phases: any[]) {
  return phases.reduce((max, p) => Math.max(max, p.day_end), 0);
}

Deno.serve(async () => {
  const now = londonNow();
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');
  const subsByUser: Record<string, any[]> = {};
  (subs as any[]).forEach(s => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  const { data: prefsRows } = await sbFetch(`/rest/v1/notification_prefs?notif_key=eq.peptide&select=user_id,enabled`);
  const prefsByUser: Record<string, any> = {};
  ((prefsRows as any[]) || []).forEach(p => { prefsByUser[p.user_id] = p; });

  const { data: protocols } = await sbFetch(
    '/rest/v1/peptide_protocols?is_active=eq.true&select=id,user_id,name,start_date,phases'
  );
  if (!(protocols as any[])?.length) return new Response('no active protocols');

  let sent = 0, failed = 0, skipped = 0, completed = 0;

  for (const protocol of protocols as any[]) {
    if (protocol.user_id === GEMMA_USER_ID) { skipped++; continue; } // no peptide protocol UI wired for her yet
    if (prefsByUser[protocol.user_id]?.enabled === false) { skipped++; continue; }
    const userSubs = subsByUser[protocol.user_id];
    if (!userSubs?.length) { skipped++; continue; }
    const nowMin = now.hour * 60 + now.minute;
    if (!Briefings.isDue(Briefings.PEPTIDE_NUDGE_MINUTE, nowMin)) { skipped++; continue; }

    const day = dayNumber(protocol.start_date, now.dateStr);
    const phase = currentPhase(protocol.phases, day);
    if (!phase) {
      if (day > lastPhaseDay(protocol.phases)) {
        // Genuinely past the last phase's day_end — course is done,
        // stop prompting for it automatically.
        await sbPatch(`/rest/v1/peptide_protocols?id=eq.${protocol.id}`, { is_active: false });
        completed++;
      } else {
        // A rest/gap day within an otherwise-active, non-daily schedule
        // (e.g. a twice-weekly protocol's off days) — nothing due today,
        // but the protocol itself is still very much active.
        skipped++;
      }
      continue;
    }

    const { data: doseRows } = await sbFetch(
      `/rest/v1/peptide_doses?protocol_id=eq.${protocol.id}&injected_at=gte.${now.dateStr}&select=id&limit=1`
    );
    if ((doseRows as any[])?.length) { skipped++; continue; } // already logged today

    const body = `Day ${day} — ${phase.label}. Today's dose: ${phase.dose_mg}mg (${phase.units} units). Log it in fitl00p.`;
    const kind = Briefings.nudgeDue({ nudgeMinutes: [Briefings.PEPTIDE_NUDGE_MINUTE], nowMin, loggedToday: false,
      sentKinds: await sentKinds(sbFetch, protocol.user_id, now.dateStr), kind: 'peptide_nudge' });
    if (!kind || !(await claim(protocol.user_id, kind, now.dateStr))) { skipped++; continue; }
    const payload = { title: `💉 ${protocol.name}`, body, url: '/', tag: 'peptide-reminder' };
    const pushed = await sendToSubscriptions(userSubs, payload);
    sent += pushed.sent; failed += pushed.failed;
    await recordBody(protocol.user_id, kind, now.dateStr, body);
  }

  return new Response(JSON.stringify({ sent, failed, skipped, completed }));
});
