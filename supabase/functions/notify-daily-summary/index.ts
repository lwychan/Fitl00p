// Scheduled: fires at both the summer and winter UTC equivalents of 07:00
// Europe/London (see londonNow() in _shared/webpush.ts for why), and
// exits immediately unless it's actually 07:00 local right now. Sends
// every subscribed user the same three readiness dials shown on the
// dashboard — Recovery and Sleep as of this morning, Strain from the
// completed day before — plus a plain-language load suggestion for
// today, derived from the Recovery tier.
//
// Ported from src/netlify/functions/notify-daily-summary.js — mechanical
// translation to Deno.serve; logic unchanged.

import { sendWebPush, londonNow } from '../_shared/webpush.ts';
import { computeRecoveryScore, computeSleepScore, computeStrainScore, loadSuggestion } from '../_shared/health-scores.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function buildSummary(userId: string, todayStr: string, yesterdayStr: string) {
  const windowStart = addDays(todayStr, -30);

  const [{ data: healthRows }, { data: logRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${windowStart}&log_date=lte.${todayStr}&select=log_date,hrv_ms,resting_hr,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,exercise_mins,workout_hr_avg&order=log_date.asc`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=eq.${yesterdayStr}&select=log_date,active_energy_kcal`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=age_years`),
  ]);

  const health = (healthRows as any[]) || [];
  const yesterdayLog = ((logRows as any[]) || [])[0] || null;
  const ageYears = (profileRows as any[])?.[0]?.age_years;

  const todayHealth     = health.find((h: any) => h.log_date === todayStr) || {};
  const yesterdayHealth = health.find((h: any) => h.log_date === yesterdayStr) || {};

  const recovery = computeRecoveryScore(todayHealth, health);
  const sleep    = computeSleepScore(todayHealth, health);
  const strain   = computeStrainScore(yesterdayHealth, health, yesterdayLog, ageYears);

  const scoreParts: string[] = [];
  if (recovery.score != null) scoreParts.push(`Recovery ${recovery.score}`);
  if (sleep.score != null)    scoreParts.push(`Sleep ${sleep.score}`);
  if (strain.score != null)   scoreParts.push(`Strain ${strain.score} (yesterday)`);
  if (!scoreParts.length) return null;

  let body = scoreParts.join(' · ');
  const load = loadSuggestion(recovery.score);
  if (load) body += `\nSuggested load: ${load.word} — ${load.reason}.`;

  return body;
}

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 7) return new Response('not 07:00 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });

  const yesterday = addDays(now.dateStr, -1);

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return new Response('no subscriptions');

  const byUser: Record<string, any[]> = {};
  subs.forEach((s: any) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

  let sent = 0, failed = 0;
  for (const [userId, userSubs] of Object.entries(byUser)) {
    const body = await buildSummary(userId, now.dateStr, yesterday);
    if (!body) continue;
    const payload = { title: '⚡ Today’s Readiness', body, url: '/', tag: 'daily-summary' };
    for (const s of userSubs) {
      try {
        const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
        if (r.status >= 200 && r.status < 300) sent++; else failed++;
      } catch { failed++; }
    }
  }
  return new Response(JSON.stringify({ sent, failed }));
});
