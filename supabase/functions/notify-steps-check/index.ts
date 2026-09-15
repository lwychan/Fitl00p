// Scheduled: fires at both UTC equivalents of 16:00 Europe/London and
// exits unless it's actually 16:00 local right now (see londonNow() in
// _shared/webpush.ts). Only sends a notification when today's step count
// is both known (synced) and under 9,000 — no data yet is treated as
// "don't know", not "behind", so it stays silent rather than
// false-alarming.
//
// Ported from src/netlify/functions/notify-steps-check.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendWebPush, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const STEP_THRESHOLD = 9000;
const STEP_GOAL      = 12000;

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 16) return new Response('not 16:00 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');

  const byUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const { data: healthRows } = await sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=eq.${now.dateStr}&select=steps`);
    const steps = healthRows?.[0]?.steps;
    if (steps == null || steps >= STEP_THRESHOLD) { skipped++; continue; }

    const toGo = STEP_GOAL - steps;
    const title = userId === GEMMA_USER_ID ? 'Darling get off your bum lazy! 🚶🏻💨💨' : 'Get a move on suckaa!! 🚶🏻💨💨';
    const payload = {
      title,
      body: `${steps.toLocaleString()} steps so far today — ${toGo.toLocaleString()} to go to hit your ${STEP_GOAL.toLocaleString()} goal.`,
      url: '/', tag: 'steps-check',
    };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
