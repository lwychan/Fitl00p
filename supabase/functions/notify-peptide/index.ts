// Scheduled: cron fires every 30 minutes, covering both UTC equivalents
// of the BST/GMT offset, across a window wide enough for the earliest
// per-protocol start time (see reminder_start_hour below) through 21:30
// Europe/London; each run self-gates to only actually proceed for
// protocols whose own window it's currently inside (see londonNow() in
// _shared/webpush.ts) — same cadence the old BPC-157/Tirzepatide
// reminders used. Keeps re-firing until a dose has been logged for
// today, then goes quiet for the rest of the day.
//
// Deliberately generic rather than hardcoded to one peptide: reads
// whatever peptide_protocols row is active for each user (name, start
// date, phase schedule) so switching protocols is a data change, not a
// new scheduled function. reminder_start_hour/reminder_start_minute
// (both nullable, defaulting to 07:30) let one protocol's reminders
// start earlier than another's without a dedicated function — e.g. an
// 05:30 start for a protocol dosed before the working day.
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

import { sendWebPush, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const DEFAULT_WINDOW_START_HOUR   = 7;  // gate also checks minute >= 30 below
const DEFAULT_WINDOW_START_MINUTE = 30;
const WINDOW_END_HOUR   = 21;
const WINDOW_END_MINUTE = 30;

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}
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

function inProtocolWindow(protocol: any, now: { hour: number; minute: number }) {
  const startHour   = protocol.reminder_start_hour   ?? DEFAULT_WINDOW_START_HOUR;
  const startMinute = protocol.reminder_start_minute ?? DEFAULT_WINDOW_START_MINUTE;
  const afterStart = now.hour > startHour || (now.hour === startHour && now.minute >= startMinute);
  const beforeEnd  = now.hour < WINDOW_END_HOUR || (now.hour === WINDOW_END_HOUR && now.minute <= WINDOW_END_MINUTE);
  return afterStart && beforeEnd;
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
    '/rest/v1/peptide_protocols?is_active=eq.true&select=id,user_id,name,start_date,phases,reminder_start_hour,reminder_start_minute'
  );
  if (!(protocols as any[])?.length) return new Response('no active protocols');

  let sent = 0, failed = 0, skipped = 0, completed = 0;

  for (const protocol of protocols as any[]) {
    if (protocol.user_id === GEMMA_USER_ID) { skipped++; continue; } // no peptide protocol UI wired for her yet
    if (prefsByUser[protocol.user_id]?.enabled === false) { skipped++; continue; }
    const userSubs = subsByUser[protocol.user_id];
    if (!userSubs?.length) { skipped++; continue; }
    if (!inProtocolWindow(protocol, now)) { skipped++; continue; }

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
    const payload = { title: `💉 ${protocol.name}`, body, url: '/', tag: 'peptide-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }

  return new Response(JSON.stringify({ sent, failed, skipped, completed }));
});
