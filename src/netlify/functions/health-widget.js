// netlify/functions/health-widget.js
// Compact daily-stats JSON for the Scriptable iOS home-screen widget.
// Auth: Bearer <api_key> header — reuses the same personal API key already
// issued for Health Auto Export (see health-apikey.js / health-sync.js),
// so a widget user doesn't need to generate a second key.
//
// GET only. Returns the SAME three numbers the app's own "Today" hero
// card shows — Recovery and Sleep scores (0-100, ported from
// computeRecoveryScore/computeSleepScore in app.js) and Strain (0-21,
// ported from computeStrainScore) — plus consumed/target calories using
// the same pickConsumedCalories precedence used everywhere else in the
// app (native food_log sum > MFP diary cal_mfp > summed HealthKit
// samples). None of these three scores are persisted server-side, so all
// of it is recomputed here from the same raw health_daily fields the app
// itself reads.

const crypto = require('crypto');

const SB_URL     = process.env.SUPABASE_URL;
const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const STRAIN_MAX     = 21;
const STRAIN_K_TRIMP  = 0.0085;
const STRAIN_K_KCAL   = 0.00081;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function tanakaHrMax(ageYears) { return 208 - 0.7 * (ageYears || 35); }

// Personal rolling baseline — see the identical helper + comment in
// app.js. Needs >=5 data points to be meaningful; callers fall back to
// fixed thresholds below that.
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

// Ported from computeRecoveryScore in app.js — keep the weights/
// thresholds below in sync with that function; this deliberately drops
// the factors/label it also returns since the widget only shows the
// number, but the score itself must match exactly.
function computeRecoveryScore(health, healthHistory) {
  let totalScore = 0, totalWeight = 0;
  const todayDate = health?.log_date;

  const hrv = health?.hrv_ms;
  if (hrv != null) {
    const baseline = baselineMean(healthHistory, 'hrv_ms', todayDate);
    const hrvScore = baseline != null
      ? scoreVsBaseline(hrv, baseline, 200, true)
      : (hrv >= 100 ? 100 : hrv >= 80 ? 90 : hrv >= 60 ? 78 : hrv >= 40 ? 62 : hrv >= 25 ? 45 : hrv >= 15 ? 28 : 15);
    totalScore += hrvScore * 0.40; totalWeight += 0.40;
  }

  const rhr = health?.resting_hr;
  if (rhr != null) {
    const baseline = baselineMean(healthHistory, 'resting_hr', todayDate);
    const rhrScore = baseline != null
      ? scoreVsBaseline(rhr, baseline, 300, false)
      : (rhr < 50 ? 100 : rhr < 55 ? 92 : rhr < 60 ? 82 : rhr < 65 ? 70 : rhr < 70 ? 58 : rhr < 80 ? 42 : 25);
    totalScore += rhrScore * 0.25; totalWeight += 0.25;
  }

  const rr = health?.respiratory_rate;
  if (rr != null) {
    const baseline = baselineMean(healthHistory, 'respiratory_rate', todayDate);
    const rrScore = baseline != null ? scoreVsBaseline(rr, baseline, 40, false) : null;
    if (rrScore != null) { totalScore += rrScore * 0.10; totalWeight += 0.10; }
  }

  const wristTemp = health?.wrist_temp_dev;
  if (wristTemp != null) {
    const tempScore = wristTemp <= 0.3 ? 100 : wristTemp <= 0.6 ? 80 : wristTemp <= 1.0 ? 55 : wristTemp <= 1.5 ? 30 : 10;
    totalScore += tempScore * 0.10; totalWeight += 0.10;
  }

  const sleep = health?.sleep_total_hrs;
  if (sleep != null) {
    let sleepScore = tieredSleepDurationScore(sleep);
    const deep = health?.sleep_deep_hrs || 0;
    const rem  = health?.sleep_rem_hrs  || 0;
    sleepScore = Math.min(100, sleepScore + Math.min(10, (deep + rem) * 5));
    totalScore += sleepScore * 0.25; totalWeight += 0.25;
  }

  if (totalWeight === 0) return null;
  return Math.round(totalScore / totalWeight);
}

// Ported from computeSleepScore in app.js — same note as above re:
// keeping weights/thresholds in sync; factors/label dropped, score only.
function computeSleepScore(health, healthHistory) {
  const sleep = health?.sleep_total_hrs;
  if (sleep == null) return null;

  let totalScore = 0, totalWeight = 0;

  const durScore = tieredSleepDurationScore(sleep);
  totalScore += durScore * 0.40; totalWeight += 0.40;

  const scoreStagePct = (pct, idealLo, idealHi) => {
    if (pct >= idealLo && pct <= idealHi) return 100;
    if (pct < idealLo) return clamp(100 - (idealLo - pct) * 8, 15, 95);
    return clamp(100 - (pct - idealHi) * 6, 15, 95);
  };

  const deep = health?.sleep_deep_hrs;
  if (deep != null && sleep > 0) {
    const deepScore = scoreStagePct((deep / sleep) * 100, 13, 23);
    totalScore += deepScore * 0.25; totalWeight += 0.25;
  }

  const rem = health?.sleep_rem_hrs;
  if (rem != null && sleep > 0) {
    const remScore = scoreStagePct((rem / sleep) * 100, 20, 25);
    totalScore += remScore * 0.25; totalWeight += 0.25;
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
    }
  }

  if (totalWeight === 0) return null;
  return Math.round(totalScore / totalWeight);
}

function computeStrainScore(dailyActiveKcal, restingHr, ageYears, sex, workouts) {
  const valid = (workouts || []).filter(w => Number.isFinite(Number(w.avg_heart_rate)));
  if (dailyActiveKcal == null && !valid.length) return { score: null, label: '' };

  const hrMax = tanakaHrMax(ageYears);
  const isFemale = sex === 'female';

  let cumulativeTrimp = 0;
  let workoutKcal = 0;
  for (const w of valid) {
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
  const label = score >= 15 ? 'All-out day' :
                score >= 10 ? 'High strain' :
                score >= 6  ? 'Moderate' :
                score >= 2  ? 'Light' : 'Very low';
  return { score, label };
}

function pickConsumedCalories(nativeSum, calMfp, dietaryKcal) {
  if (nativeSum != null) return Number(nativeSum);
  if (calMfp != null) return Number(calMfp);
  if (dietaryKcal != null) return Number(dietaryKcal);
  return null;
}

// Mifflin-St Jeor — same formula/fallback as calcBmr in app.js, used
// when resting_energy_kcal isn't available from Apple Health (e.g. no
// Watch, or a day it hasn't synced yet).
function calcBmr(weightKg, heightCm, ageYears, sex) {
  if (!weightKg || !heightCm || !ageYears) return null;
  return sex === 'female'
    ? (10 * weightKg) + (6.25 * heightCm) - (5 * ageYears) - 161
    : (10 * weightKg) + (6.25 * heightCm) - (5 * ageYears) + 5;
}

// Ported from fetchLatestWeightKg in app.js — checks both possible
// sources (health_daily.weight_kg from Apple Health, daily_logs.weight
// from manual entry — both canonical kg) and returns whichever has the
// more recent log_date.
async function fetchLatestWeightKg(user_id) {
  const [healthRes, logRes] = await Promise.all([
    sbFetch(`/rest/v1/health_daily?user_id=eq.${user_id}&weight_kg=not.is.null&select=weight_kg,log_date&order=log_date.desc&limit=1`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${user_id}&weight=not.is.null&select=weight,log_date&order=log_date.desc&limit=1`),
  ]);
  const h = healthRes.data?.[0];
  const l = logRes.data?.[0];
  if (h && (!l || h.log_date >= l.log_date)) return Number(h.weight_kg) || null;
  if (l) return Number(l.weight) || null;
  return h ? Number(h.weight_kg) || null : null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'GET only' }) };
  }
  if (!SB_URL || !SB_SERVICE) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const keyRes  = await sbFetch(`/rest/v1/health_api_keys?key_hash=eq.${keyHash}&select=user_id,id`);
  if (!keyRes.ok || !keyRes.data?.length) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid API key' }) };
  }
  const { user_id, id: keyId } = keyRes.data[0];
  sbFetch(`/rest/v1/health_api_keys?id=eq.${keyId}`, 'PATCH', { last_used: new Date().toISOString() });

  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const startOfDayIso = new Date(`${today}T00:00:00.000Z`).toISOString();

  const HEALTH_FIELDS = 'log_date,hrv_ms,resting_hr,respiratory_rate,wrist_temp_dev,sleep_total_hrs,sleep_deep_hrs,sleep_rem_hrs,sleep_start,active_energy_kcal,resting_energy_kcal,dietary_energy_kcal';

  const [profRes, healthRes, historyRes, dailyLogRes, foodRes, workoutsRes, latestWeightKg] = await Promise.all([
    sbFetch(`/rest/v1/profiles?id=eq.${user_id}&select=age_years,sex,height_cm,eat_target_kcal,eat_target_manual_kcal,tdee`),
    sbFetch(`/rest/v1/health_daily?user_id=eq.${user_id}&log_date=eq.${today}&select=${HEALTH_FIELDS}`),
    // 30-day window feeds baselineMean (HRV/RHR/respiratory-rate personal
    // baselines) and sleep-start consistency — same window the dashboard
    // itself uses for these two scores.
    sbFetch(`/rest/v1/health_daily?user_id=eq.${user_id}&log_date=gte.${thirtyDaysAgo}&select=log_date,hrv_ms,resting_hr,respiratory_rate,sleep_start`),
    sbFetch(`/rest/v1/daily_logs?user_id=eq.${user_id}&log_date=eq.${today}&select=cal_mfp`),
    sbFetch(`/rest/v1/food_log?user_id=eq.${user_id}&log_date=eq.${today}&select=calories_kcal`),
    sbFetch(`/rest/v1/apple_health_workouts?user_id=eq.${user_id}&started_at=gte.${startOfDayIso}&select=avg_heart_rate,active_energy_kcal,started_at,ended_at`),
    fetchLatestWeightKg(user_id),
  ]);

  const profile = profRes.data?.[0] || {};
  const health   = { ...(healthRes.data?.[0] || {}), log_date: today };
  const healthHistory = historyRes.data || [];
  const calMfp   = dailyLogRes.data?.[0]?.cal_mfp ?? null;
  const nativeSum = (foodRes.data || []).reduce((sum, r) => (r.calories_kcal != null ? sum + Number(r.calories_kcal) : sum), null);

  const consumed = pickConsumedCalories(nativeSum, calMfp, health.dietary_energy_kcal ?? null);
  const target = profile.eat_target_manual_kcal ?? profile.eat_target_kcal
    ?? (profile.tdee ? profile.tdee - 500 : null);

  const strain = computeStrainScore(
    health.active_energy_kcal ?? null,
    health.resting_hr ?? null,
    profile.age_years,
    profile.sex,
    workoutsRes.data || []
  );

  // Burned = active + resting energy, same as renderNetCalories/
  // totalBurn in app.js — resting falls back to a Mifflin-St Jeor BMR
  // estimate when Apple Health hasn't supplied resting_energy_kcal (no
  // Watch, or not synced yet today), same fallback the dashboard uses.
  const bmrFallback = calcBmr(latestWeightKg, profile.height_cm, profile.age_years, profile.sex);
  const active  = health.active_energy_kcal ?? null;
  const resting = health.resting_energy_kcal ?? bmrFallback;
  const burned  = (active == null && resting == null) ? null : Math.round((active || 0) + (resting || 0));
  // Positive = deficit (burned more than eaten), negative = surplus —
  // the everyday-language framing of "how big is today's deficit",
  // opposite sign convention from app.js's own internal `net` variable.
  const deficit = (consumed != null && burned != null) ? Math.round(burned - consumed) : null;

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      date: today,
      recovery: computeRecoveryScore(health, healthHistory),
      sleep: computeSleepScore(health, healthHistory),
      strain: strain.score != null ? { score: strain.score, label: strain.label, max: STRAIN_MAX } : null,
      calories: {
        consumed: consumed != null ? Math.round(consumed) : null,
        target: target != null ? Math.round(target) : null,
        remaining: (consumed != null && target != null) ? Math.round(target - consumed) : null,
        burned,
        deficit,
      },
    }),
  };
};

async function sbFetch(path, method = 'GET', body = null) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_SERVICE,
        'Authorization': `Bearer ${SB_SERVICE}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.ok && method !== 'DELETE' ? await res.json().catch(() => null) : null;
    return { ok: res.ok, status: res.status, data, error: !res.ok ? await res.text().catch(() => '') : null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}
