// netlify/functions/notify-daily-summary.js
// Scheduled: fires at both the summer and winter UTC equivalents of
// 07:00 Europe/London (see londonNow() in _lib/webpush.js for why), and
// exits immediately unless it's actually 07:00 local right now. Sends
// every subscribed user the same three readiness dials shown on the
// dashboard — Recovery and Sleep as of this morning, Strain from the
// completed day before — plus a plain-language load suggestion for
// today, derived from the Recovery tier.

const { sendWebPush, londonNow } = require('./_lib/webpush');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

async function sbFetch(path) {
  const res = await fetch(`${SB_URL}${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!res.ok) return { ok: false, data: null };
  return { ok: true, data: await res.json() };
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Scoring engine — ported verbatim from app.js's dashboard dials ──
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function fmt1(n) { return Number(n).toFixed(1); }

function baselineMean(history, field, excludeDate) {
  const vals = (history || [])
    .filter(h => h.log_date !== excludeDate && h[field] != null)
    .map(h => Number(h[field]));
  if (vals.length < 5) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function scoreVsBaseline(value, baseline, sensitivity, higherIsBetter) {
  if (value == null || !baseline) return null;
  const pctDev = (value - baseline) / baseline;
  const signed = higherIsBetter ? pctDev : -pctDev;
  return clamp(50 + signed * sensitivity, 0, 100);
}

function tieredSleepDurationScore(hrs) {
  if (hrs >= 8) return 100;
  if (hrs >= 7) return 88;
  if (hrs >= 6) return 70;
  if (hrs >= 5) return 50;
  if (hrs >= 4) return 30;
  return 15;
}

function computeRecoveryScore(health, healthHistory) {
  let totalScore = 0, totalWeight = 0;
  const factors = [];
  const todayDate = health?.log_date;

  const hrv = health?.hrv_ms;
  if (hrv != null) {
    const baseline = baselineMean(healthHistory, 'hrv_ms', todayDate);
    const hrvScore = baseline != null
      ? scoreVsBaseline(hrv, baseline, 200, true)
      : (hrv >= 100 ? 100 : hrv >= 80 ? 90 : hrv >= 60 ? 78 : hrv >= 40 ? 62 : hrv >= 25 ? 45 : hrv >= 15 ? 28 : 15);
    totalScore += hrvScore * 0.35; totalWeight += 0.35;
    factors.push({ label: 'HRV', val: `${Math.round(hrv)}ms`, pct: Math.round(hrvScore), cls: 'hrv' });
  }

  const rhr = health?.resting_hr;
  if (rhr != null) {
    const baseline = baselineMean(healthHistory, 'resting_hr', todayDate);
    const rhrScore = baseline != null
      ? scoreVsBaseline(rhr, baseline, 300, false)
      : (rhr < 50 ? 100 : rhr < 55 ? 92 : rhr < 60 ? 82 : rhr < 65 ? 70 : rhr < 70 ? 58 : rhr < 80 ? 42 : 25);
    totalScore += rhrScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'Resting HR', val: `${Math.round(rhr)}bpm`, pct: Math.round(rhrScore), cls: 'hr' });
  }

  const sleep = health?.sleep_total_hrs;
  if (sleep != null) {
    let sleepScore = tieredSleepDurationScore(sleep);
    const deep = health?.sleep_deep_hrs || 0;
    const rem  = health?.sleep_rem_hrs  || 0;
    sleepScore = Math.min(100, sleepScore + Math.min(10, (deep + rem) * 5));
    totalScore += sleepScore * 0.40; totalWeight += 0.40;
    factors.push({ label: 'Sleep', val: `${fmt1(sleep)}h`, pct: Math.round(sleepScore), cls: 'sleep' });
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };
  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'Well recovered — great day to push hard.' :
                score >= 60 ? 'Good recovery — normal training is fine.' :
                score >= 40 ? 'Below your usual — consider a lighter session.' :
                score >= 20 ? 'Low — prioritise recovery today.' :
                              'Poorly recovered — rest day recommended.';
  return { score, label, factors };
}

function computeSleepScore(health, healthHistory) {
  const sleep = health?.sleep_total_hrs;
  if (sleep == null) return { score: null, label: '', factors: [] };

  let totalScore = 0, totalWeight = 0;
  const factors = [];

  const durScore = tieredSleepDurationScore(sleep);
  totalScore += durScore * 0.40; totalWeight += 0.40;
  factors.push({ label: 'Duration', val: `${fmt1(sleep)}h`, pct: Math.round(durScore), cls: 'sleep' });

  const scoreStagePct = (pct, idealLo, idealHi) => {
    if (pct >= idealLo && pct <= idealHi) return 100;
    if (pct < idealLo) return clamp(100 - (idealLo - pct) * 8, 15, 95);
    return clamp(100 - (pct - idealHi) * 6, 15, 95);
  };

  const deep = health?.sleep_deep_hrs;
  if (deep != null && sleep > 0) {
    const deepPct = (deep / sleep) * 100;
    const deepScore = scoreStagePct(deepPct, 13, 23);
    totalScore += deepScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'Deep sleep', val: `${Math.round(deepPct)}%`, pct: Math.round(deepScore), cls: 'deep' });
  }

  const rem = health?.sleep_rem_hrs;
  if (rem != null && sleep > 0) {
    const remPct = (rem / sleep) * 100;
    const remScore = scoreStagePct(remPct, 20, 25);
    totalScore += remScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'REM sleep', val: `${Math.round(remPct)}%`, pct: Math.round(remScore), cls: 'rem' });
  }

  const sleepStart = health?.sleep_start;
  if (sleepStart) {
    const timeOfDayMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
    const recentStarts = (healthHistory || [])
      .filter(h => h.log_date !== health.log_date && h.sleep_start)
      .slice(-14)
      .map(h => timeOfDayMin(h.sleep_start));
    if (recentStarts.length >= 5) {
      const todayMin = timeOfDayMin(sleepStart);
      const avgMin = recentStarts.reduce((a, b) => a + b, 0) / recentStarts.length;
      const rawDiff = Math.abs(todayMin - avgMin);
      const diff = Math.min(rawDiff, 1440 - rawDiff);
      const consistencyScore = clamp(100 - diff, 20, 100);
      totalScore += consistencyScore * 0.10; totalWeight += 0.10;
      factors.push({ label: 'Consistency', val: `±${Math.round(diff)}m`, pct: Math.round(consistencyScore), cls: 'consistency' });
    }
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };
  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'Great night — solid duration and architecture.' :
                score >= 60 ? 'Good sleep, some room to improve.' :
                score >= 40 ? 'Below par — try to catch up tonight.' :
                              'Poor sleep — expect it to affect today.';
  return { score, label, factors };
}

function computeStrainScore(health, healthHistory, log, ageYears) {
  const active = health?.active_energy_kcal ?? log?.active_energy_kcal;
  if (active == null) return { score: null, label: '', factors: [] };

  let totalScore = 0, totalWeight = 0;
  const factors = [];

  const activeBaseline = baselineMean(healthHistory, 'active_energy_kcal', health?.log_date);
  const activeScore = activeBaseline != null
    ? scoreVsBaseline(active, activeBaseline, 60, true)
    : clamp((active / 700) * 100, 0, 100);
  totalScore += activeScore * 0.45; totalWeight += 0.45;
  factors.push({ label: 'Active energy', val: `${Math.round(active)} kcal`, pct: Math.round(activeScore), cls: 'active' });

  const exMins = health?.exercise_mins;
  if (exMins != null) {
    const exScore = clamp((exMins / 60) * 100, 0, 100);
    totalScore += exScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'Exercise', val: `${exMins}m`, pct: Math.round(exScore), cls: 'exercise' });
  }

  const workoutHr = health?.workout_hr_avg;
  if (workoutHr) {
    const estMaxHr = 220 - (ageYears || 35);
    const intensityScore = clamp((workoutHr / estMaxHr) * 100, 0, 100);
    totalScore += intensityScore * 0.30; totalWeight += 0.30;
    factors.push({ label: 'Workout intensity', val: `${Math.round(workoutHr)}bpm avg`, pct: Math.round(intensityScore), cls: 'intensity' });
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };
  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'High strain — big effort today.' :
                score >= 50 ? 'Moderate strain today.' :
                score >= 20 ? 'Light day so far.' :
                              'Very low strain so far today.';
  return { score, label, factors };
}

// Short "what to do about it" clause, keyed off the Recovery tier —
// this is the "suggestion of load for the day" the notification adds
// on top of the raw dials.
function loadSuggestion(recoveryScore) {
  if (recoveryScore == null) return null;
  if (recoveryScore >= 80) return { word: 'push hard', reason: 'well recovered' };
  if (recoveryScore >= 60) return { word: 'train normally', reason: 'good recovery' };
  if (recoveryScore >= 40) return { word: 'go light', reason: 'recovery below usual' };
  if (recoveryScore >= 20) return { word: 'active recovery', reason: 'low recovery' };
  return { word: 'rest day', reason: 'poorly recovered' };
}

async function buildSummary(userId, todayStr, yesterdayStr) {
  const windowStart = addDays(todayStr, -30);

  const [{ data: healthRows }, { data: logRows }, { data: profileRows }] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${userId}&log_date=gte.${windowStart}&log_date=lte.${todayStr}&select=log_date,hrv_ms,resting_hr,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,exercise_mins,workout_hr_avg&order=log_date.asc`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${userId}&log_date=eq.${yesterdayStr}&select=log_date,active_energy_kcal`),
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=age_years`),
  ]);

  const health = healthRows || [];
  const yesterdayLog = (logRows || [])[0] || null;
  const ageYears = profileRows?.[0]?.age_years;

  const todayHealth     = health.find(h => h.log_date === todayStr) || {};
  const yesterdayHealth = health.find(h => h.log_date === yesterdayStr) || {};

  const recovery = computeRecoveryScore(todayHealth, health);
  const sleep    = computeSleepScore(todayHealth, health);
  const strain   = computeStrainScore(yesterdayHealth, health, yesterdayLog, ageYears);

  const scoreParts = [];
  if (recovery.score != null) scoreParts.push(`Recovery ${recovery.score}`);
  if (sleep.score != null)    scoreParts.push(`Sleep ${sleep.score}`);
  if (strain.score != null)   scoreParts.push(`Strain ${strain.score} (yesterday)`);
  if (!scoreParts.length) return null;

  let body = scoreParts.join(' · ');
  const load = loadSuggestion(recovery.score);
  if (load) body += `\nSuggested load: ${load.word} — ${load.reason}.`;

  return body;
}

exports.handler = async function () {
  const now = londonNow();
  if (now.hour !== 7) return { statusCode: 200, body: 'not 07:00 London — skipping' };
  if (!SB_URL || !SB_SERVICE) return { statusCode: 500, body: 'Supabase env vars missing' };

  const yesterday = addDays(now.dateStr, -1);

  const { data: subs } = await sbFetch('/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth_key');
  if (!subs?.length) return { statusCode: 200, body: 'no subscriptions' };

  const byUser = {};
  subs.forEach(s => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s); });

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
  return { statusCode: 200, body: JSON.stringify({ sent, failed }) };
};
