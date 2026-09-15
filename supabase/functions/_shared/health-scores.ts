// Shared readiness scoring — Recovery/Sleep/Strain dials, ported
// verbatim from app.js's dashboard gauges. Extracted here so
// notify-daily-summary.js and notify-ai-coach.js compute the exact same
// numbers a person sees on the dashboard, rather than two copies that
// could quietly drift apart.

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

// ── TRIMP-based strain + sleep need (ported verbatim from app.js) ──
// The computeStrainScore above predates app.js's later switch to a real
// Banister-TRIMP model and was never updated to match — it's kept as-is
// since notify-ai-coach.js/coach-ask.js/notify-daily-summary.js already
// depend on its exact signature and 0-100 scale. computeSleepNeed's own
// f(strain) curve is calibrated specifically for the newer 0-21 TRIMP
// scale, so it needs the real thing, not this file's older score — hence
// a second, additive strain function here (computeStrainScoreTrimp)
// rather than reusing or replacing the one above.
const STRAIN_MAX = 21;
const STRAIN_K_TRIMP = 0.0085;
const STRAIN_K_KCAL  = 0.00081;
function tanakaHrMax(ageYears) { return 208 - 0.7 * (ageYears || 35); }

function computeStrainScoreTrimp(health, log, workoutsToday, ageYears, isFemale) {
  const dailyActiveKcal = health?.active_energy_kcal ?? log?.active_energy_kcal;
  const workouts = (workoutsToday || []).filter(w => Number.isFinite(Number(w.avg_heart_rate)));
  if (dailyActiveKcal == null && !workouts.length) return { score: null };

  const restingHr = health?.resting_hr;
  const hrMax = tanakaHrMax(ageYears);

  let cumulativeTrimp = 0;
  let workoutKcal = 0;
  for (const w of workouts) {
    const avgHr = Number(w.avg_heart_rate);
    const durMin = (new Date(w.ended_at) - new Date(w.started_at)) / 60000;
    workoutKcal += Number(w.active_energy_kcal) || 0;
    if (restingHr == null || !Number.isFinite(durMin) || durMin <= 0 || hrMax <= restingHr) continue;
    const hrr = clamp((avgHr - restingHr) / (hrMax - restingHr), 0, 1);
    cumulativeTrimp += isFemale
      ? durMin * hrr * 0.86 * Math.exp(1.67 * hrr)
      : durMin * hrr * 0.64 * Math.exp(1.92 * hrr);
  }

  const residualKcal = Math.max(0, (dailyActiveKcal || 0) - workoutKcal);
  const strainFraction = 1 - Math.exp(-(STRAIN_K_TRIMP * cumulativeTrimp + STRAIN_K_KCAL * residualKcal));
  const score = Math.round(STRAIN_MAX * strainFraction * 10) / 10;
  return { score };
}

const SLEEP_NEED_BASELINE_HRS = 8;
const SLEEP_DEBT_CAP_HRS      = 1.5;
const SLEEP_NAP_THRESHOLD_HRS = 4;

function computeSleepNeed(healthHistory, todayDate, strainScore) {
  const strainHours = strainScore != null
    ? 1.7 / (1 + Math.exp((17 - strainScore) / 3.5))
    : 0;

  const priorNights = (healthHistory || [])
    .filter(h => h.log_date < todayDate && h.sleep_total_hrs != null && h.sleep_total_hrs >= SLEEP_NAP_THRESHOLD_HRS)
    .sort((a, b) => b.log_date.localeCompare(a.log_date))
    .slice(0, 3);
  const shortfallSum = priorNights.reduce((sum, h) => sum + Math.max(0, SLEEP_NEED_BASELINE_HRS - h.sleep_total_hrs), 0);
  const debtHours = Math.min(SLEEP_DEBT_CAP_HRS, 0.35 * shortfallSum);

  const needHours = SLEEP_NEED_BASELINE_HRS + strainHours + debtHours;
  return { needHours, baselineHours: SLEEP_NEED_BASELINE_HRS, strainHours, debtHours };
}

// Short "what to do about it" clause, keyed off the Recovery tier.
function loadSuggestion(recoveryScore) {
  if (recoveryScore == null) return null;
  if (recoveryScore >= 80) return { word: 'push hard', reason: 'well recovered' };
  if (recoveryScore >= 60) return { word: 'train normally', reason: 'good recovery' };
  if (recoveryScore >= 40) return { word: 'go light', reason: 'recovery below usual' };
  if (recoveryScore >= 20) return { word: 'active recovery', reason: 'low recovery' };
  return { word: 'rest day', reason: 'poorly recovered' };
}

export {
  clamp, fmt1, baselineMean, scoreVsBaseline, tieredSleepDurationScore,
  computeRecoveryScore, computeSleepScore, computeStrainScore, loadSuggestion,
  computeStrainScoreTrimp, computeSleepNeed,
};
