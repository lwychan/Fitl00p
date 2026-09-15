// Scheduled: fires at both UTC equivalents of 07:15 Europe/London and
// exits unless it's actually 07:15 local right now (see londonNow() in
// _shared/webpush.ts). A daily version of notify-weighin.js's Tuesday-only
// reminder, targeted at Gemma specifically — see GEMMA_USER_ID in
// _shared/webpush.ts for why this is a separate function rather than a
// per-user setting.
//
// Ported from src/netlify/functions/notify-weighin-gemma.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendWebPush, londonNow, GEMMA_USER_ID, kgToLb } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

async function buildReminder(todayDateStr: string) {
  const [{ data: todayHealthRows }, { data: todayLogRows }, { data: planRows }, { data: healthRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${GEMMA_USER_ID}&log_date=eq.${todayDateStr}&weight_kg=not.is.null&select=weight_kg`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${GEMMA_USER_ID}&log_date=eq.${todayDateStr}&weight=not.is.null&select=weight`),
    sbFetch(`/rest/v1/weight_plans?user_id=eq.${GEMMA_USER_ID}&is_active=eq.true&select=target_weight&order=created_at.desc&limit=1`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${GEMMA_USER_ID}&weight_kg=not.is.null&select=weight_kg&order=log_date.desc&limit=1`),
    sbFetch(`/rest/v1/profiles?id=eq.${GEMMA_USER_ID}&select=weight_unit`),
  ]);

  const alreadyLoggedToday = ((todayHealthRows as any[])?.length || 0) > 0 || ((todayLogRows as any[])?.length || 0) > 0;
  if (alreadyLoggedToday) return null;

  const base = 'Morning weigh-in ⚖️ — pop on the scale and log it in fitl00p.';

  const plan   = (planRows as any[])?.[0];
  const latest = (healthRows as any[])?.[0]?.weight_kg != null ? Number((healthRows as any[])[0].weight_kg) : null;
  const unit   = (profileRows as any[])?.[0]?.weight_unit || 'kg';
  if (!plan || latest == null) return base;

  // latest and plan.target_weight are both stored as canonical kg — convert
  // to her display unit rather than just labelling the raw kg number,
  // which previously gave a wrong reading whenever unit was 'lb'.
  const latestDisp = unit === 'lb' ? kgToLb(latest) : latest;
  const targetDisp = unit === 'lb' ? kgToLb(Number(plan.target_weight)) : Number(plan.target_weight);
  const toGo = latestDisp - targetDisp;
  if (Math.abs(toGo) < 0.05) return `${base} You’re right at your ${targetDisp.toFixed(1)}${unit} goal.`;
  return `${base} ${toGo.toFixed(1)}${unit} to your ${targetDisp.toFixed(1)}${unit} goal.`;
}

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 7) return new Response('not 07:15 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch(`/rest/v1/push_subscriptions?user_id=eq.${GEMMA_USER_ID}&select=endpoint,p256dh,auth_key`);
  if (!subs?.length) return new Response('no subscriptions');

  const body = await buildReminder(now.dateStr);
  if (!body) return new Response('already logged today');

  const payload = { title: 'Weigh-in day', body, url: '/', tag: 'weighin-reminder' };
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
      if (r.status >= 200 && r.status < 300) sent++; else failed++;
    } catch { failed++; }
  }
  return new Response(JSON.stringify({ sent, failed }));
});
