// Scheduled: fires at both UTC equivalents of 20:00 Europe/London and
// exits unless it's actually 20:00 local right now (see londonNow() in
// _shared/webpush.ts). One notification a day, no repeat-until-logged
// loop like notify-peptide.js — there's nothing to "complete", just a
// number worth knowing before bed.
//
// Computes the same personalised sleep-need figure the dashboard's Sleep
// gauge detail shows, using computeSleepNeed(healthHistory, today,
// todayStrainScore) from _shared/health-scores.ts — pointed at TODAY's own
// strain (so far) rather than yesterday's, since that's what should drive
// how much sleep tonight calls for. Sent to both accounts — this is a
// general fitness feature, not gated on profile.diabetes_enabled the way
// the peptide/glucose reminders are.
//
// Ported from src/netlify/functions/notify-sleep-target.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendWebPush, londonNow } from '../_shared/webpush.ts';
import { computeStrainScoreTrimp, computeSleepNeed, fmt1 } from '../_shared/health-scores.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 20) return new Response('not 20:00 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');

  const byUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  const historyStart = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

  let sent = 0, failed = 0, skipped = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const [{ data: profiles }, { data: history }, { data: workouts }] = await Promise.all([
      sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=age_years,sex`),
      sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${historyStart}&select=log_date,sleep_total_hrs,active_energy_kcal,resting_hr&order=log_date.desc`),
      sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${userId}&started_at=gte.${now.dateStr}T00:00:00Z&select=avg_heart_rate,started_at,ended_at,active_energy_kcal`),
    ]);
    const profile = (profiles as any[])?.[0] || null;
    const historyArr = (history as any[]) || [];
    const todayHealth = historyArr.find((h: any) => h.log_date === now.dateStr) || null;
    if (!historyArr.length) { skipped++; continue; }

    const strain = computeStrainScoreTrimp(todayHealth, null, workouts, profile?.age_years, profile?.sex === 'female');
    const sleepNeed = computeSleepNeed(historyArr, now.dateStr, strain.score);
    if (sleepNeed?.needHours == null) { skipped++; continue; }

    const extras: string[] = [];
    if (sleepNeed.strainHours > 0.02) extras.push(`+${fmt1(sleepNeed.strainHours)}h for today's strain`);
    if (sleepNeed.debtHours > 0.02) extras.push(`+${fmt1(sleepNeed.debtHours)}h catching up on recent debt`);
    const body = `Aim for ${fmt1(sleepNeed.needHours)}h sleep tonight` + (extras.length ? ` (${extras.join(', ')}).` : '.');

    const payload = { title: '🌙 Sleep target', body, url: '/', tag: 'sleep-target' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return new Response(JSON.stringify({ sent, failed, skipped }));
});
