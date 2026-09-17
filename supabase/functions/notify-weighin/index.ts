// Scheduled: intended to be invoked hourly. Fires once per user at their
// own configured day(s)-of-week + hour (notif_key 'weighin' in
// notification_prefs — default Tuesday, 10:00 London), single-shot rather
// than the old always-Tuesday retry-until-logged loop.
//
// Ported from src/netlify/functions/notify-weighin.js — mechanical
// translation to Deno.serve; day/hour made per-user configurable since.

import { sendWebPush, londonNow, GEMMA_USER_ID, kgToLb } from '../_shared/webpush.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

// notif_key 'weighin' — per-user day(s)-of-week + hour (default Tuesday, 10:00
// London), shared between this function and notify-weighin-gemma since it's
// one concept ("weigh-in reminder") to the user regardless of which function
// actually runs for their account.
const WEEKDAY_TO_NUM: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

async function buildReminder(userId: string, todayDateStr: string) {
  const [{ data: todayHealthRows }, { data: todayLogRows }, { data: planRows }, { data: healthRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=eq.${todayDateStr}&weight_kg=not.is.null&select=weight_kg`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=eq.${todayDateStr}&weight=not.is.null&select=weight`),
    sbFetch(`/rest/v1/weight_plans?user_id=eq.${userId}&is_active=eq.true&select=target_weight&order=created_at.desc&limit=1`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&weight_kg=not.is.null&select=weight_kg&order=log_date.desc&limit=1`),
  ]);

  const alreadyLoggedToday = ((todayHealthRows as any[])?.length || 0) > 0 || ((todayLogRows as any[])?.length || 0) > 0;
  if (alreadyLoggedToday) return null;

  const base = 'Weigh-in reminder ⚖️ — pop on the scale and log it in fitl00p.';

  const plan   = (planRows as any[])?.[0];
  const latest = (healthRows as any[])?.[0]?.weight_kg != null ? Number((healthRows as any[])[0].weight_kg) : null;
  if (!plan || latest == null) return base;

  // Body weight always displays in lb (see app.js's BODY_WEIGHT_UNIT) — both
  // latest and plan.target_weight are stored as canonical kg, so both need
  // converting here rather than just labelling the raw kg number "lb".
  const unit = 'lb';
  const latestLb = kgToLb(latest);
  const targetLb = kgToLb(Number(plan.target_weight));
  const toGo = latestLb - targetLb;
  if (Math.abs(toGo) < 0.1) return `${base} You’re right at your ${targetLb.toFixed(1)}${unit} goal.`;
  return `${base} ${toGo.toFixed(1)}${unit} to your ${targetLb.toFixed(1)}${unit} goal.`;
}

Deno.serve(async () => {
  const now = londonNow();
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');

  const byUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  const { data: prefsRows } = await sbFetch(`/rest/v1/notification_prefs?notif_key=eq.weighin&select=user_id,enabled,check_hour,days_of_week`);
  const prefsByUser: Record<string, any> = {};
  ((prefsRows as any[]) || []).forEach(p => { prefsByUser[p.user_id] = p; });
  const nowDow = WEEKDAY_TO_NUM[now.weekday];

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    if (userId === GEMMA_USER_ID) { skipped++; continue; } // has her own daily reminder — see notify-weighin-gemma
    const prefs = prefsByUser[userId];
    if (prefs?.enabled === false) { skipped++; continue; }
    const days: number[] = prefs?.days_of_week ?? [2]; // default Tuesday
    if (!days.includes(nowDow)) { skipped++; continue; }
    if (now.hour !== (prefs?.check_hour ?? 10)) { skipped++; continue; }

    const body = await buildReminder(userId, now.dateStr);
    if (!body) { skipped++; continue; }
    const payload = { title: 'Weigh-in day', body, url: '/', tag: 'weighin-reminder' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
