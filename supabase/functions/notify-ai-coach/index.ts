// Scheduled: fires at both UTC equivalents of 08:00 Europe/London (see
// londonNow() in _shared/webpush.ts for why), an hour after the plain
// readiness push from notify-daily-summary so overnight Health sync
// has had time to land. For every profile (not just push-subscribed
// ones — the briefing is stored and shown in-app regardless of whether
// a push notification can be delivered), gathers yesterday's
// recovery/sleep, this week's training sessions, this week's calorie
// balance so far, and — for diabetes-enabled profiles — a 7-day
// insulin health check and any flagged patterns, then asks Claude to
// write one short, cross-domain morning briefing. Stored in
// ai_coach_briefings (one row per user per day) for the dashboard card
// to read; a push notification with a one-line teaser is sent to
// whoever has a subscription.
//
// Deliberately doesn't try to recompute the in-app Diabetes tab's full
// per-time-block regimen suggestions — that's a heavier, more precise
// analysis already available there. This briefing surfaces the
// higher-level "worth a look" signal (an insulinHealthCheck stat, a
// flagged pattern) and points back to that tab rather than duplicating
// its reasoning from a thinner nightly data pull.
//
// Ported from src/netlify/functions/notify-ai-coach.js — mechanical
// translation to Deno.serve; logic unchanged. fetchNightscoutInput now
// comes from _shared/nightscout-fetch.ts (shared with
// notify-glucose-forecast) instead of the sibling function file the
// Netlify version required() — see that shared file's header comment
// for why importing one function's index.ts from another isn't safe
// under Deno.serve.

import { sendWebPush, londonNow } from '../_shared/webpush.ts';
import { computeRecoveryScore, computeSleepScore, computeStrainScore } from '../_shared/health-scores.ts';
import { fetchNightscoutInput } from '../_shared/nightscout-fetch.ts';
import DiabetesEngine from '../_shared/diabetes-engine.ts';

const SB_URL     = Deno.env.get('SUPABASE_URL');
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_KEY');
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// Reasoning across several unrelated data domains (training, nutrition,
// insulin) into one coherent, well-prioritised briefing is worth
// Sonnet's extra cost over Haiku — same call food-photo-estimate.js
// makes for its harder before/after comparison.
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const DX_GAP_REASON_LABELS: Record<string, string> = {
  site_failure: 'infusion site came out',
  pump_issue: 'pump issue',
  missed_dose: 'missed a dose',
  other: 'insulin gap',
};

async function sbFetch(path: string) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

// Most recent insulin gap still worth mentioning — either still ongoing,
// or resolved within the last 12h (long enough to still explain a high
// that landed a few hours after the gap closed, short enough that it
// doesn't linger in every briefing/answer for days afterwards).
async function fetchRecentInsulinGap(userId: string) {
  const twelveHoursAgo = new Date(Date.now() - 12 * 3600000).toISOString();
  const res = await sbFetch(
    `/rest/v1/diabetes_insulin_gaps?user_id=eq.${userId}&or=(ended_at.is.null,ended_at.gte.${twelveHoursAgo})` +
    `&select=started_at,ended_at,reason,note&order=started_at.desc&limit=1`
  );
  return (res.data as any[])?.[0] || null;
}
// `on_conflict` is required here — ai_coach_briefings' primary key is
// `id` (fresh on every insert), while the real one-row-per-user-per-day
// constraint is the separate UNIQUE(user_id, briefing_date). Without
// naming it, PostgREST's merge-duplicates upsert targets the primary
// key by default, which never collides, so this would silently insert
// a new row every run instead of updating today's in place.
async function sbUpsert(path: string, body: unknown) {
  await fetch(`${SB_URL}${path}?on_conflict=user_id,briefing_date`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE!, Authorization: `Bearer ${SB_SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the London-calendar week containing dateStr — "this week's
// training/calories so far" means since Monday, not a rolling 7 days.
function mondayOfWeek(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// Same precedence pickConsumedCalories/totalBurn use client-side (see
// app.js) — kept identical so the deficit this briefing reports never
// disagrees with what the dashboard itself shows for the same days.
function consumedFor(dayLog: any, healthRow: any) {
  if (dayLog?.cal_fitl00p != null) return Number(dayLog.cal_fitl00p);
  if (dayLog?.cal_mfp != null) return Number(dayLog.cal_mfp);
  if (healthRow?.dietary_energy_kcal != null) return Number(healthRow.dietary_energy_kcal);
  if (dayLog?.cal_apple != null) return Number(dayLog.cal_apple);
  if (dayLog?.cal_total > 0) return Number(dayLog.cal_total);
  return null;
}
function burnedFor(healthRow: any) {
  const a = healthRow?.active_energy_kcal != null ? Number(healthRow.active_energy_kcal) : null;
  const r = healthRow?.resting_energy_kcal != null ? Number(healthRow.resting_energy_kcal) : null;
  if (a != null && r != null) return a + r;
  if (a != null) return a;
  return null;
}

// Builds the week-to-date training/calorie/weight section of the
// prompt from already-fetched rows. Pure function — no I/O — so it's
// unit-testable without hitting Supabase.
function buildWeekSummary({ weekStart, todayStr, dailyLogs, healthRows, foodLogRows, sessions }: any) {
  const healthByDate: Record<string, any> = {}; (healthRows || []).forEach((h: any) => { healthByDate[h.log_date] = h; });
  const logByDate: Record<string, any> = {}; (dailyLogs || []).forEach((l: any) => { logByDate[l.log_date] = l; });
  const foodByDate: Record<string, number> = {};
  (foodLogRows || []).forEach((r: any) => { foodByDate[r.log_date] = (foodByDate[r.log_date] || 0) + (Number(r.calories_kcal) || 0); });

  let weeklyNet = 0, deficitDays = 0, loggedCalDays = 0;
  const dayLines: string[] = [];
  const weightPoints: { date: string; weightKg: number }[] = [];
  for (let d = weekStart; d <= todayStr; d = addDays(d, 1)) {
    const health = healthByDate[d];
    const log = { ...(logByDate[d] || {}), cal_fitl00p: foodByDate[d] ?? null };
    const consumed = consumedFor(log, health);
    const burned = burnedFor(health);
    if (consumed != null) loggedCalDays++;
    if (consumed != null && burned != null) { weeklyNet += (consumed - burned); deficitDays++; }
    const weightKg = log.weight != null ? Number(log.weight) : (health?.weight_kg != null ? Number(health.weight_kg) : null);
    if (weightKg != null) weightPoints.push({ date: d, weightKg });
    if (consumed != null || burned != null || log.steps != null || weightKg != null) {
      dayLines.push(`${d}: ${consumed != null ? Math.round(consumed) + ' kcal eaten' : 'no food logged'}` +
        `${burned != null ? `, ${Math.round(burned)} kcal burned` : ''}` +
        `${log.steps != null ? `, ${log.steps} steps` : ''}` +
        `${weightKg != null ? `, weight ${weightKg.toFixed(1)}kg` : ''}`);
    }
  }
  const weightDeltaKg = weightPoints.length >= 2
    ? Math.round((weightPoints[weightPoints.length - 1].weightKg - weightPoints[0].weightKg) * 10) / 10
    : null;

  const sessionLines = (sessions || []).map((s: any) => {
    const exercises = s.workout_exercises || [];
    const setCount = exercises.reduce((n: number, ex: any) => n + (ex.workout_sets || []).length, 0);
    const volume = exercises.reduce((v: number, ex: any) => v + (ex.workout_sets || []).reduce((sv: number, st: any) => sv + (Number(st.weight) || 0) * (Number(st.reps) || 0), 0), 0);
    return `${s.session_date}: ${s.split_type || 'workout'} — ${exercises.length} exercises, ${setCount} sets${volume > 0 ? `, ~${Math.round(volume)}kg total volume` : ''}`;
  });

  return {
    dayLines, sessionLines,
    weeklyNetKcal: deficitDays > 0 ? Math.round(weeklyNet) : null,
    deficitDays, loggedCalDays, weightDeltaKg,
    sessionCount: (sessions || []).length,
  };
}

// Trims analyzePatterns' insight arrays down to short "title: summary"
// lines for the prompt — the full objects carry extra fields (n,
// extra) the model doesn't need to write one paragraph.
function insightLines(insights: any[], limit: number) {
  return (insights || []).slice(0, limit).map(i => `${i.title}: ${i.summary}`);
}

// Builds the labelled real-data context blocks shared by the scheduled
// briefing prompt and coach-ask.js's on-demand Q&A — both want the same
// grounding, just wrapped in different instructions.
function buildContextSections({ goal, recovery, sleep, strain, week, diabetes }: any) {
  const sections: string[] = [];

  sections.push(`RECOVERY & SLEEP (this morning / overnight):\n` +
    `${recovery.score != null ? `Recovery ${recovery.score}/100 — ${recovery.label}` : 'No recovery score available.'}\n` +
    `${sleep.score != null ? `Sleep ${sleep.score}/100 — ${sleep.label}` : 'No sleep score available.'}\n` +
    `${strain.score != null ? `Yesterday's strain ${strain.score}/100 — ${strain.label}` : ''}`);

  sections.push(`THIS WEEK'S TRAINING SO FAR (goal: ${goal || 'not set'}):\n` +
    (week.sessionLines.length ? week.sessionLines.join('\n') : 'No strength sessions logged yet this week.'));

  sections.push(`THIS WEEK'S CALORIE BALANCE SO FAR:\n` +
    (week.dayLines.length ? week.dayLines.join('\n') : 'No calorie/step data logged yet this week.') +
    (week.weeklyNetKcal != null
      ? `\nRunning total (${week.deficitDays} day${week.deficitDays === 1 ? '' : 's'} with both eaten+burned data): ${week.weeklyNetKcal < 0 ? Math.abs(week.weeklyNetKcal) + ' kcal deficit' : week.weeklyNetKcal + ' kcal surplus'} so far.`
      : '') +
    (week.weightDeltaKg != null
      ? `\nWeight this week: ${week.weightDeltaKg > 0 ? '+' : ''}${week.weightDeltaKg}kg.`
      : ''));

  if (diabetes) {
    const hc = diabetes.healthCheck;
    const hcLine = hc?.sufficient
      ? `Trailing 7 days: time-in-range ${hc.thisWeek.tir?.pctInRange != null ? Math.round(hc.thisWeek.tir.pctInRange) + '%' : 'n/a'}, ` +
        `avg CV ${hc.thisWeek.cv != null ? hc.thisWeek.cv.toFixed(0) + '%' : 'n/a'}, ` +
        `total daily dose ~${hc.thisWeek.tdd?.toFixed(1) ?? 'n/a'}u (${hc.thisWeek.basalPct != null ? Math.round(hc.thisWeek.basalPct) + '% basal' : 'basal split n/a'})` +
        (hc.trend ? `. Vs the week before: TIR ${hc.trend.tirDelta >= 0 ? '+' : ''}${hc.trend.tirDelta.toFixed(0)}pt, TDD ${hc.trend.tddDelta >= 0 ? '+' : ''}${hc.trend.tddDelta.toFixed(1)}u/day.` : '.')
      : 'Not enough recent CGM data for a reliable week-over-week check.';
    const attention = insightLines(diabetes.patterns?.needsAttention, 3);
    const worthKnowing = insightLines(diabetes.patterns?.worthKnowing, 2);
    const gap = diabetes.insulinGap;
    const gapLine = gap
      ? `\nKnown insulin gap: ${DX_GAP_REASON_LABELS[gap.reason] || gap.reason} since ${new Date(gap.started_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}` +
        (gap.ended_at ? `, resolved ${new Date(gap.ended_at).toLocaleString([], { hour: '2-digit', minute: '2-digit' })}` : ' — still ongoing') +
        (gap.note ? ` (${gap.note})` : '') + '. Any highs since then have a known, already-identified cause — do not treat them as an unexplained pattern.'
      : '';
    sections.push(`DIABETES OVERVIEW:\n${hcLine}` +
      (attention.length ? `\nFlagged patterns:\n${attention.join('\n')}` : '') +
      (worthKnowing.length ? `\nAlso worth knowing:\n${worthKnowing.join('\n')}` : '') +
      gapLine);
  }

  return sections;
}

function buildPrompt({ profileLabel, goal, recovery, sleep, strain, week, diabetes }: any) {
  const sections = buildContextSections({ goal, recovery, sleep, strain, week, diabetes });

  return `You are writing a short personal morning briefing for ${profileLabel}, from their fitness/diabetes tracking app's real data below. Write 3-5 short sections, each starting with a one-word or short label followed by a colon, then 1-3 plain sentences that reference the actual numbers given rather than being generic. Cover, only where the data below actually supports it:
1. Today's training load, given recovery/sleep.
2. This week's calorie balance so far vs. what the training/goal implies.
3. Diabetes/insulin observations, if a diabetes section is present — frame these as "worth checking in the Diabetes tab" (which already does detailed per-time-block regimen analysis), not as something to act on from this summary alone.
4. Anything else genuinely notable in the data (a trend, a flag) — skip this section if there's nothing worth saying.

Skip any section with no real data rather than padding it. Keep the whole reply under 220 words. Plain text only — no markdown, no bullet characters, no headings with #, just short labelled paragraphs separated by a blank line.

${sections.join('\n\n')}`;
}

async function callClaude(prompt: string) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude API error (${res.status}): ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data?.content || []).map((c: any) => c.text || '').join('').trim();
}

// Named exports — for unit testing the pure logic without network
// calls, and for coach-ask.js to reuse the same data-gathering/context
// shape for its on-demand Q&A.
export { mondayOfWeek, buildWeekSummary, buildContextSections, buildPrompt, fetchRecentInsulinGap };

Deno.serve(async () => {
  const now = londonNow();
  if (now.hour !== 8) return new Response('not 08:00 London — skipping');
  if (!SB_URL || !SB_SERVICE) return new Response('Supabase env vars missing', { status: 500 });
  if (!ANTHROPIC_API_KEY) return new Response('ANTHROPIC_API_KEY not configured', { status: 500 });

  const todayStr = now.dateStr;
  const yesterday = addDays(todayStr, -1);
  const weekStart = mondayOfWeek(todayStr);
  const windowStart = addDays(todayStr, -30);

  const [{ data: profiles }, { data: subs }] = await Promise.all([
    sbFetch('/rest/v1/profiles?select=id,goal,tdee,age_years,height_cm,sex,diabetes_enabled,diabetes_ns_url,diabetes_ns_token,diabetes_ns_secret,diabetes_target_low,diabetes_target_high,diabetes_ideal_target,diabetes_carb_ratio,diabetes_correction_factor,diabetes_insulin_peak_min,diabetes_insulin_duration_min'),
    sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key'),
  ]);
  if (!(profiles as any[])?.length) return new Response('no profiles');

  const subsByUser: Record<string, any[]> = {};
  ((subs as any[]) || []).forEach(s => { (subsByUser[s.user_id] = subsByUser[s.user_id] || []).push(s); });

  let generated = 0, sent = 0, failed = 0, errors = 0;

  for (const profile of profiles as any[]) {
    const userId = profile.id;
    try {
      const [healthRes, dailyLogsRes, foodLogRes, sessionsRes] = await Promise.all([
        sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${windowStart}&log_date=lte.${todayStr}&select=log_date,hrv_ms,resting_hr,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,resting_energy_kcal,dietary_energy_kcal,exercise_mins,workout_hr_avg,steps,weight_kg&order=log_date.asc`),
        sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=gte.${weekStart}&log_date=lte.${todayStr}&select=log_date,weight,steps,cal_total,cal_apple,cal_mfp`),
        sbFetch(`/rest/v1/food_log?user_id=eq.${userId}&log_date=gte.${weekStart}&log_date=lte.${todayStr}&select=log_date,calories_kcal`),
        sbFetch(`/rest/v1/workout_sessions?user_id=eq.${userId}&session_date=gte.${weekStart}&session_date=lte.${todayStr}&select=session_date,split_type,workout_exercises(name,workout_sets(reps,weight))&order=session_date.asc`),
      ]);

      const healthRows = (healthRes.data as any[]) || [];
      const todayHealth = healthRows.find(h => h.log_date === todayStr) || {};
      const yestHealth  = healthRows.find(h => h.log_date === yesterday) || todayHealth;

      const recovery = computeRecoveryScore(todayHealth, healthRows);
      const sleep    = computeSleepScore(todayHealth, healthRows);
      const strain   = computeStrainScore(yestHealth, healthRows, null, profile.age_years);

      const week = buildWeekSummary({
        weekStart, todayStr,
        dailyLogs: dailyLogsRes.data || [],
        healthRows,
        foodLogRows: foodLogRes.data || [],
        sessions: sessionsRes.data || [],
      });

      let diabetes = null;
      if (profile.diabetes_enabled && profile.diabetes_ns_url) {
        const input = await fetchNightscoutInput(profile);
        if (input) {
          const healthCheck = DiabetesEngine.insulinHealthCheck(input, Date.now());
          const patterns = DiabetesEngine.analyzePatterns(input, Date.now());
          const insulinGap = await fetchRecentInsulinGap(userId);
          diabetes = { healthCheck, patterns, insulinGap };
        }
      }

      if (recovery.score == null && sleep.score == null && !week.dayLines.length && !week.sessionLines.length && !diabetes) {
        continue; // genuinely nothing to say — new/inactive profile
      }

      const prompt = buildPrompt({
        profileLabel: 'this person', goal: profile.goal, recovery, sleep, strain, week, diabetes,
      });
      const content = await callClaude(prompt);
      if (!content) continue;

      await sbUpsert('/rest/v1/ai_coach_briefings', {
        user_id: userId, briefing_date: todayStr, content,
      });
      generated++;

      const userSubs = subsByUser[userId];
      if (userSubs?.length) {
        const teaser = content.split('\n').find((l: string) => l.trim()) || 'Your morning briefing is ready.';
        const payload = { title: '🧭 Morning Briefing', body: teaser.slice(0, 140), url: '/', tag: 'ai-coach-briefing' };
        for (const s of userSubs) {
          try {
            const r = await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } }, payload);
            if (r.status >= 200 && r.status < 300) sent++; else failed++;
          } catch { failed++; }
        }
      }
    } catch (err) {
      console.error(`notify-ai-coach failed for user ${userId}:`, (err as Error).message);
      errors++;
    }
  }

  return new Response(JSON.stringify({ generated, sent, failed, errors }));
});
