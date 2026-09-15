// Scheduled: fires at both UTC equivalents of 09:00, 12:00, 16:00 and
// 20:00 Europe/London and exits unless the real local time (see
// londonNow() in _shared/webpush.ts) is actually one of those four —
// prompts opening Health Auto Export so it pushes fresh data into
// fitl00p. Targeted at Gemma specifically — see GEMMA_USER_ID in
// _shared/webpush.ts for why this is a separate function rather than a
// per-user setting.
//
// Ported from src/netlify/functions/notify-sync-reminder-gemma.js —
// mechanical translation to Deno.serve; logic unchanged. Actual cron
// scheduling (Netlify's netlify.toml [functions] schedule) still needs
// its Supabase equivalent wired up separately.

import { sendWebPush, londonNow, GEMMA_USER_ID } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_KEY');
const TARGET_HOURS = [9, 12, 16, 20];

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

Deno.serve(async () => {
  const now = londonNow();
  if (!TARGET_HOURS.includes(now.hour)) return new Response('not a sync-reminder hour — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch(`/rest/v1/push_subscriptions?user_id=eq.${GEMMA_USER_ID}&select=endpoint,p256dh,auth_key`);
  if (!subs?.length) return new Response('no subscriptions');

  const payload = {
    title: '🔄 Sync reminder',
    body: 'Open Health Auto Export to sync today’s data into fitl00p.',
    url: '/', tag: 'sync-reminder',
  };

  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
      if (r.status >= 200 && r.status < 300) sent++; else failed++;
    } catch { failed++; }
  }
  return new Response(JSON.stringify({ sent, failed }));
});
