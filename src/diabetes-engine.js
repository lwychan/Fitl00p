'use strict';

// Everything below is wrapped in an IIFE so that, when loaded as a plain
// browser <script> alongside app.js, none of this file's internal helper
// names (e.g. fmtSigned, mean, clamp) leak into the shared global script
// scope and collide with identically-named top-level declarations
// elsewhere on the page — only the DiabetesEngine export escapes.
(function () {

/* ═══════════════════════════════════════════════════════════
   fitl00p — Diabetes Insights Engine
   Pure Node/CommonJS. No framework, no database — every function
   takes plain arrays/objects in and returns plain data out.

   NOT medical software. A single-user heuristic pattern-spotting
   tool for improving time-in-range, built on population-average
   insulin/carb action curves — not a clinical dosing calculator.
   Every downstream number should stay "may help" / "worth a
   glance", never "take X units", and should carry its sample
   size rather than fake precision.

   STAGE 1 — IOB / COB models + shared "dosing context" helper
   ═══════════════════════════════════════════════════════════ */

// ── Tunables ──────────────────────────────────────────────
const IOB_PEAK_MINUTES      = 75;   // rapid-acting insulin peak activity
const IOB_DURATION_MINUTES  = 240;  // duration of insulin action (DIA)
const COB_DURATION_MINUTES  = 180;  // carb absorption window (linear)
const STALE_READING_MINUTES = 30;   // CGM reading older than this = stale
const TREND_WINDOW_MINUTES  = 20;   // lookback window for trend slope
const PROJECTION_MINUTES    = 30;   // how far ahead "effective glucose" looks
const PROJECTION_CLAMP      = 2;    // max mmol/L adjustment the projection may apply

// Real pump profiles carry their own configured insulin duration/peak
// (e.g. a Tandem profile reporting insulinDuration=180 rather than the
// 240min Loop/OpenAPS default) — when settings.insulinDurationMinutes /
// settings.insulinPeakMinutes are present, every IOB-curve calculation
// downstream should use them instead of the generic defaults.
function insulinCurveOpts(settings) {
  return {
    peak: settings?.insulinPeakMinutes || IOB_PEAK_MINUTES,
    duration: settings?.insulinDurationMinutes || IOB_DURATION_MINUTES,
  };
}

// ── Time helpers ──────────────────────────────────────────
function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : ms;
}
function minutesBetween(fromMs, toMsVal) { return (toMsVal - fromMs) / 60000; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ─────────────────────────────────────────────────────────
   IOB — exponential Loop/OpenAPS insulin activity curve
   Standard oref0 model: given a peak time and total duration, tau/a/S
   are derived once (cached) and fully determine the curve's shape.
   ───────────────────────────────────────────────────────── */
const _iobCurveCache = new Map();
function _iobCurveParams(peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES) {
  const key = `${peak}:${duration}`;
  if (_iobCurveCache.has(key)) return _iobCurveCache.get(key);
  const tau = peak * (1 - peak / duration) / (1 - 2 * peak / duration);
  const a   = 2 * tau / duration;
  const S   = 1 / (1 - a + (1 + a) * Math.exp(-duration / tau));
  const params = { tau, a, S, peak, duration };
  _iobCurveCache.set(key, params);
  return params;
}

// Fraction of a single dose still ON BOARD (not yet metabolised) `t`
// minutes after it was taken. 1 at t<=0, decays to 0 at t>=duration.
function iobFraction(t, peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES) {
  if (t <= 0) return 1;
  if (t >= duration) return 0;
  const { tau, a, S } = _iobCurveParams(peak, duration);
  return 1 - S * (1 - a) * (
    (t * t / (tau * duration * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1
  );
}

// Sums IOB (in units) across boluses + corrections at time `now`.
// Rows with units<=0 (carbs-only bolus entries) don't contribute — food
// is handled by COB below, not IOB.
function activeInsulin(boluses, corrections, now, opts = {}) {
  const { peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES } = opts;
  const nowMs = toMs(now);
  let total = 0;
  for (const dose of [...(boluses || []), ...(corrections || [])]) {
    const units = Number(dose.units) || 0;
    if (units <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > nowMs) continue;
    total += units * iobFraction(minutesBetween(doseMs, nowMs), peak, duration);
  }
  return total;
}

/* ─────────────────────────────────────────────────────────
   COB — linear carb absorption over 180 minutes
   ───────────────────────────────────────────────────────── */

// Fraction of a meal's carbs still ON BOARD (unabsorbed) `t` minutes
// after it was eaten. 1 at t<=0, straight line down to 0 at t>=duration.
function cobFraction(t, duration = COB_DURATION_MINUTES) {
  if (t <= 0) return 1;
  if (t >= duration) return 0;
  return 1 - t / duration;
}

// Sums COB (in grams) across bolus rows with carbs logged, at time `now`.
// A units:0 "carbs-only" row still counts — it's food in the gut either way.
function carbsOnBoard(boluses, now, opts = {}) {
  const { duration = COB_DURATION_MINUTES } = opts;
  const nowMs = toMs(now);
  let total = 0;
  for (const dose of boluses || []) {
    const carbs = Number(dose.carbs) || 0;
    if (carbs <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > nowMs) continue;
    total += carbs * cobFraction(minutesBetween(doseMs, nowMs), duration);
  }
  return total;
}

// Corrects the Nightscout boluses array's carbs figures against the
// user's own MFP-logged meals (macroMealLog / diabetes_meals) before any
// COB/carb-interference calculation runs. Tandem's Control-IQ can reduce
// or withhold a bolus entirely when current BG is low — the meal still
// gets eaten, but Nightscout never receives a treatment carrying the
// real carb figure for it (or receives one with the wrong number), so
// every downstream carbsOnBoard()/carbAbsorptionWithin() call would
// silently miss carbs that are actually in the gut. Each meal's own
// eaten_at timestamp is the more reliable "carbs eaten, right now"
// signal, so it supersedes rather than merely supplements Nightscout's
// figure: a meal already matched to a real bolus overrides that dose's
// carbs field (insulin units/time stay Nightscout's, only carbs move to
// the MFP figure); an unmatched meal — exactly the low-BG-suppressed-
// dose case — is added as its own units:0 carbs-only row.
function mergeMealCarbsIntoBoluses(boluses, macroMealLog) {
  const list = (boluses || []).map(dose => ({ ...dose }));
  for (const meal of macroMealLog || []) {
    const carbs = Number(meal.carbs_g ?? meal.carbs) || 0;
    const eatenAt = meal.eaten_at ?? meal.time;
    if (carbs <= 0 || eatenAt == null) continue;

    const matchedAt = meal.matched_bolus_time ? toMs(meal.matched_bolus_time) : null;
    const match = matchedAt != null
      ? list.find(d => { const dMs = toMs(d.time); return dMs != null && Math.abs(dMs - matchedAt) < 5 * 60000; })
      : null;

    if (match) {
      match.carbs = carbs;
    } else {
      list.push({ time: eatenAt, units: 0, carbs });
    }
  }
  return list;
}

/* ─────────────────────────────────────────────────────────
   Within-horizon variants
   "How much of the currently-active IOB/COB will actually exert itself
   in the next H minutes" — not the whole remaining tail. Computed per
   dose as (remaining now) − (remaining at now+H), floored at 0, summed.
   This is what keeps a short forecast honest: insulin/carbs that will
   still be active well past the horizon aren't counted as if landing now.

   Returned in NATIVE units (insulin units / grams) — Stage 1 has no
   personal correction factor yet to convert these into a mmol/L swing.
   That conversion happens downstream once Stage 2's factor exists.
   ───────────────────────────────────────────────────────── */
function insulinActionWithin(boluses, corrections, now, horizonMinutes, opts = {}) {
  const { peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES } = opts;
  const nowMs = toMs(now);
  let total = 0;
  for (const dose of [...(boluses || []), ...(corrections || [])]) {
    const units = Number(dose.units) || 0;
    if (units <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > nowMs) continue;
    const t = minutesBetween(doseMs, nowMs);
    const remainingNow   = iobFraction(t, peak, duration);
    const remainingLater = iobFraction(t + horizonMinutes, peak, duration);
    total += units * Math.max(0, remainingNow - remainingLater);
  }
  return total;
}

function carbAbsorptionWithin(boluses, now, horizonMinutes, opts = {}) {
  const { duration = COB_DURATION_MINUTES } = opts;
  const nowMs = toMs(now);
  let total = 0;
  for (const dose of boluses || []) {
    const carbs = Number(dose.carbs) || 0;
    if (carbs <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > nowMs) continue;
    const t = minutesBetween(doseMs, nowMs);
    const remainingNow   = cobFraction(t, duration);
    const remainingLater = cobFraction(t + horizonMinutes, duration);
    total += carbs * Math.max(0, remainingNow - remainingLater);
  }
  return total;
}

/* ─────────────────────────────────────────────────────────
   Trend + effective glucose
   ───────────────────────────────────────────────────────── */

// Least-squares slope (mmol/L per minute) over the trailing window —
// steadier than a raw two-point delta against single noisy CGM readings.
function computeTrend(glucoseHistory, now, windowMinutes = TREND_WINDOW_MINUTES) {
  const nowMs = toMs(now);
  const windowMs = windowMinutes * 60000;
  const recent = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && r.ms <= nowMs && r.ms >= nowMs - windowMs && !Number.isNaN(r.value))
    .sort((a, b) => a.ms - b.ms);

  if (recent.length < 2) return 0;

  const xs = recent.map(r => (r.ms - nowMs) / 60000); // minutes before now (<=0)
  const ys = recent.map(r => r.value);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den; // mmol/L per minute
}

// Projects the current reading ~30min ahead, asymmetrically: FULL credit
// for a falling trend (bias toward suggesting less insulin), HALF credit
// for a rising one (a lingering high is fixable later, an over-corrected
// low is not). The adjustment itself is clamped to ±2 mmol/L so a brief
// noisy blip can't swing a suggestion wildly.
function projectedGlucose(currentValue, trendPerMinute) {
  const rawDelta = trendPerMinute * PROJECTION_MINUTES;
  const credited = rawDelta < 0 ? rawDelta : rawDelta * 0.5;
  const adjustment = clamp(credited, -PROJECTION_CLAMP, PROJECTION_CLAMP);
  return currentValue + adjustment;
}

/* ─────────────────────────────────────────────────────────
   dosingContext — the shared snapshot every later stage builds on
   ───────────────────────────────────────────────────────── */
function dosingContext(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], settings = {} } = input || {};
  const nowMs = toMs(now);

  const readings = glucoseHistory
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && !Number.isNaN(r.value) && r.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);

  const latest = readings[readings.length - 1] || null;
  const ageMinutes = latest ? minutesBetween(latest.ms, nowMs) : null;
  const stale = !latest || ageMinutes > STALE_READING_MINUTES;

  const trendPerMinute   = latest ? computeTrend(glucoseHistory, now) : 0;
  const currentGlucose   = latest ? latest.value : null;
  const effectiveGlucose = latest ? projectedGlucose(currentGlucose, trendPerMinute) : null;

  const iob = activeInsulin(boluses, corrections, now, insulinCurveOpts(settings));
  const cob = carbsOnBoard(boluses, now);

  return {
    now: nowMs,
    currentGlucose,
    currentReadingTime: latest ? latest.ms : null,
    readingAgeMinutes: ageMinutes,
    stale,
    staleMessage: stale ? 'No recent reading — check your sensor app first.' : null,
    trendPerMinute,          // mmol/L per minute
    trendPer5Min: trendPerMinute * 5,
    effectiveGlucose,        // ~30min-projected, asymmetric, clamped
    iob,                     // units currently active (boluses + corrections)
    cob,                     // grams currently on board
    settings,
  };
}

/* ═══════════════════════════════════════════════════════════
   STAGE 2 — Correction resolution + personal correction-factor engine
   ═══════════════════════════════════════════════════════════ */

const RESOLVE_WAIT_MINUTES   = 150; // 2.5h — don't resolve before this
const RESOLVE_TARGET_MINUTES = 180; // 3h   — the reading we actually want
const RESOLVE_GIVEUP_MINUTES = 240; // 4h   — stop waiting, flag gaveUp
const ROLLING_FACTOR_WINDOW  = 10;  // most recent N clean corrections averaged
const MIN_CLEAN_SAMPLE       = 3;   // spec: need >=3 before trusting a factor
const MIN_RELIABLE_FACTOR    = 0.5; // mmol/L per unit — below this, withhold
const MAX_SUGGESTED_UNITS    = 10;  // hard cap regardless of the math
const STACKING_MIN_AGE       = 15;  // minutes
const STACKING_MAX_AGE       = 110; // minutes
const STACKING_MIN_IOB       = 0.5; // units

// Resolves a single correction against the glucose history available "as
// of" `now`. Terminal states (resolved / gaveUp) on the INPUT object are
// passed through unchanged — once a correction is locked in, it's not
// recomputed against a different slice of glucoseHistory later, so its
// dropPerUnit can't drift depending on when you happen to call this.
function resolveCorrection(correction, glucoseHistory, boluses, now) {
  if (correction.resolved || correction.gaveUp) return { ...correction };

  const startMs = toMs(correction.time);
  const nowMs = toMs(now);
  if (startMs == null) return { ...correction, resolved: false, gaveUp: false, status: 'invalid' };

  const elapsed = minutesBetween(startMs, nowMs);
  if (elapsed < RESOLVE_WAIT_MINUTES) {
    return { ...correction, resolved: false, gaveUp: false, status: 'waiting' };
  }

  const windowStart = startMs + RESOLVE_WAIT_MINUTES * 60000;
  const windowEnd    = startMs + RESOLVE_GIVEUP_MINUTES * 60000;
  const targetMs      = startMs + RESOLVE_TARGET_MINUTES * 60000;
  const searchEnd      = Math.min(windowEnd, nowMs);

  const candidates = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && !Number.isNaN(r.value) && r.ms >= windowStart && r.ms <= searchEnd);

  if (!candidates.length) {
    if (elapsed >= RESOLVE_GIVEUP_MINUTES) {
      return { ...correction, resolved: false, gaveUp: true, status: 'gaveUp' };
    }
    return { ...correction, resolved: false, gaveUp: false, status: 'waiting' };
  }

  let best = candidates[0], bestDiff = Math.abs(candidates[0].ms - targetMs);
  for (const r of candidates) {
    const diff = Math.abs(r.ms - targetMs);
    if (diff < bestDiff) { best = r; bestDiff = diff; }
  }

  const units = Number(correction.units) || 0;
  const startGlucose = Number(correction.startGlucose);
  const dropPerUnit = units > 0 && Number.isFinite(startGlucose)
    ? (startGlucose - best.value) / units
    : null;

  // Any carbs logged between the correction and the reading we resolved
  // against confound the read — the drop (or lack of it) may be food,
  // not insulin. Flag it and let the factor engine exclude it.
  const carbInterference = (boluses || []).some(b => {
    const bms = toMs(b.time);
    const carbs = Number(b.carbs) || 0;
    return carbs > 0 && bms != null && bms >= startMs && bms <= best.ms;
  });

  return {
    ...correction,
    resolved: true,
    gaveUp: false,
    status: 'resolved',
    resolvedAt: best.ms,
    actualGlucose: best.value,
    dropPerUnit,
    carbInterference,
  };
}

function resolveCorrections(corrections, glucoseHistory, boluses, now = Date.now()) {
  return (corrections || []).map(c => resolveCorrection(c, glucoseHistory, boluses, now));
}

// Rolling average dropPerUnit over the most recent clean (resolved,
// carb-free) corrections. "Clean" excludes anything still waiting/gaveUp
// or flagged with carbInterference. Needs >=3 clean samples to be trusted.
function personalCorrectionFactor(resolvedCorrections, opts = {}) {
  const { windowSize = ROLLING_FACTOR_WINDOW, minSample = MIN_CLEAN_SAMPLE } = opts;

  const clean = (resolvedCorrections || [])
    .filter(c => c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit))
    .sort((a, b) => toMs(a.time) - toMs(b.time));

  const recent = clean.slice(-windowSize);

  if (recent.length < minSample) {
    return { factor: null, sampleSize: recent.length, cleanSampleSize: clean.length, sufficient: false };
  }

  const factor = recent.reduce((sum, c) => sum + c.dropPerUnit, 0) / recent.length;
  return { factor, sampleSize: recent.length, cleanSampleSize: clean.length, sufficient: true };
}

// Blends the pump's own already-clinically-set correction factor with
// what's actually been observed here: prefer the observed factor once
// there's enough clean data to trust it (same >=3-sample gate as
// personalCorrectionFactor), otherwise fall back to the pump-setting
// value so dosing isn't blocked purely for lack of history yet. Never
// fabricates a number when neither is available.
function resolveCorrectionFactor(resolvedCorrections, settings, opts = {}) {
  const observed = personalCorrectionFactor(resolvedCorrections, opts);
  if (observed.sufficient) {
    return { factor: observed.factor, source: 'observed', sampleSize: observed.sampleSize, cleanSampleSize: observed.cleanSampleSize };
  }
  const pumpFactor = Number(settings?.correctionFactor);
  if (Number.isFinite(pumpFactor) && pumpFactor > 0) {
    return { factor: pumpFactor, source: 'pump-setting', sampleSize: observed.sampleSize, cleanSampleSize: observed.cleanSampleSize };
  }
  return { factor: null, source: null, sampleSize: observed.sampleSize, cleanSampleSize: observed.cleanSampleSize };
}

// Any dose (bolus or correction) that's 15-110min old and still carries
// >=0.5u of active IOB — the current high may already be dropping from
// it. Returns the offending doses so the caller can show why.
function detectStackingCaution(boluses, corrections, now, opts = {}) {
  const { peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES } = opts;
  const nowMs = toMs(now);
  const flagged = [];
  for (const dose of [...(boluses || []), ...(corrections || [])]) {
    const units = Number(dose.units) || 0;
    if (units <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > nowMs) continue;
    const ageMinutes = minutesBetween(doseMs, nowMs);
    if (ageMinutes < STACKING_MIN_AGE || ageMinutes > STACKING_MAX_AGE) continue;
    const remainingIob = units * iobFraction(ageMinutes, peak, duration);
    if (remainingIob >= STACKING_MIN_IOB) {
      flagged.push({ time: doseMs, units, ageMinutes, remainingIob });
    }
  }
  return flagged;
}

// Suggest dose = (effective − idealTarget)/factor − IOB, rounded to 0.5u.
// Guardrails withhold the number entirely (suggestedUnits stays null)
// rather than show something misleading — a low-confidence factor, a
// stale reading, or a still-cresting recent dose are all reasons to wait
// and look again rather than trust the math.
function suggestCorrectionDose(ctx, factorResult, boluses, corrections, now = Date.now()) {
  const settings = ctx.settings || {};
  const idealTarget = Number(settings.idealTarget);

  const base = {
    factor: factorResult.factor,
    factorSampleSize: factorResult.sampleSize,
    effectiveGlucose: ctx.effectiveGlucose,
    idealTarget,
    iob: ctx.iob,
    suggestedUnits: null,
    rawSuggestion: null,
    withheldReason: null,
    cappedAt10: false,
    stackingCaution: false,
    stackingDoses: [],
  };

  if (ctx.stale) return { ...base, withheldReason: 'stale-reading' };
  if (ctx.effectiveGlucose == null || !Number.isFinite(idealTarget)) {
    return { ...base, withheldReason: 'missing-data' };
  }
  if (factorResult.factor == null) return { ...base, withheldReason: 'insufficient-history' };
  if (factorResult.factor < MIN_RELIABLE_FACTOR) {
    return { ...base, withheldReason: 'low-confidence-factor' };
  }

  const stackingDoses = detectStackingCaution(boluses, corrections, now, insulinCurveOpts(settings));
  if (stackingDoses.length) {
    return { ...base, stackingCaution: true, stackingDoses, withheldReason: 'stacking-caution' };
  }

  const raw = (ctx.effectiveGlucose - idealTarget) / factorResult.factor - ctx.iob;
  const clamped = Math.max(0, raw); // insulin can't be un-injected — never suggest negative
  const capped = Math.min(MAX_SUGGESTED_UNITS, clamped);
  const rounded = Math.round(capped * 2) / 2;

  return {
    ...base,
    rawSuggestion: raw,
    suggestedUnits: rounded,
    cappedAt10: clamped > MAX_SUGGESTED_UNITS,
  };
}

// Convenience wrapper tying Stage 1 + Stage 2 together — the one call the
// UI actually needs for "what should I do about this reading right now".
function evaluateCorrection(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], settings = {} } = input || {};
  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factor = resolveCorrectionFactor(resolvedCorrections, settings);
  const context = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  const suggestion = suggestCorrectionDose(context, factor, boluses, corrections, now);
  return { context, resolvedCorrections, factor, suggestion };
}

/* ═══════════════════════════════════════════════════════════
   STAGE 3 — Retrospective pattern analysis
   14 checks grouped into needs-attention / going-well / worth-knowing.
   Every insight carries n (sample size) and is withheld outright if
   its own minimum sample isn't met — the overall ~20-reading gate is
   necessary but not sufficient for e.g. a dawn-phenomenon check that
   needs several distinct mornings.
   ═══════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 60 * 60000;
const PATTERN_LOOKBACK_DAYS = 7;
const PATTERN_MIN_READINGS  = 20;
const CV_TARGET_MAX_PCT     = 36;
const HYPO_FIXED_MMOL       = 3.9;  // fixed clinical low used where a check isn't about the personal range
const HYPER_FIXED_MMOL      = 10.0;
const REBOUND_PLAUSIBLE_MAX_MMOL = 4.0; // counter-regulatory rebound from a real low rarely exceeds this

function windowFilter(arr, timeField, startMs, endMs) {
  return (arr || [])
    .map(item => ({ ...item, _ms: toMs(item[timeField]) }))
    .filter(item => item._ms != null && item._ms >= startMs && item._ms <= endMs);
}

function sortedReadings(glucoseHistory, startMs, endMs) {
  return windowFilter(glucoseHistory, 'time', startMs, endMs)
    .map(r => ({ ms: r._ms, value: Number(r.value) }))
    .filter(r => !Number.isNaN(r.value))
    .sort((a, b) => a.ms - b.ms);
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null; }
function stddev(nums, m = mean(nums)) {
  if (nums.length < 2 || m == null) return null;
  return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length);
}

function glucoseStats(readings) {
  const n = readings.length;
  if (!n) return null;
  const values = readings.map(r => r.value);
  const m = mean(values);
  const sd = stddev(values, m);
  return { n, mean: m, sd, cv: sd != null && m ? (sd / m) * 100 : null };
}

function timeInRange(readings, low, high) {
  const n = readings.length;
  if (!n) return null;
  const inRange = readings.filter(r => r.value >= low && r.value <= high).length;
  const below   = readings.filter(r => r.value < low).length;
  const above   = readings.filter(r => r.value > high).length;
  return { n, pctInRange: (inRange / n) * 100, pctBelow: (below / n) * 100, pctAbove: (above / n) * 100 };
}

// Nearest reading to a target timestamp, within a tolerance window.
function nearestReading(readings, targetMs, toleranceMinutes = 15) {
  let best = null, bestDiff = Infinity;
  for (const r of readings) {
    const diff = Math.abs(r.ms - targetMs);
    if (diff < bestDiff && diff <= toleranceMinutes * 60000) { best = r; bestDiff = diff; }
  }
  return best;
}

function hourOfDay(ms) { return new Date(ms).getUTCHours(); }
function minutesSinceMidnight(ms) {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function insight(id, category, title, summary, n, extra = {}) {
  return { id, category, title, summary, n, ...extra };
}

// ── 1. Correction-factor accuracy ───────────────────────────
function patternCorrectionAccuracy(d) {
  const withPrediction = d.resolvedInWindow.filter(c =>
    c.resolved && Number.isFinite(Number(c.predictedGlucose)) && Number.isFinite(c.actualGlucose));
  const n = withPrediction.length;
  if (n < 3) return null;

  const errors = withPrediction.map(c => Math.abs(Number(c.predictedGlucose) - c.actualGlucose));
  const mae = mean(errors);

  if (mae > 2.0) {
    return insight('correction-factor-accuracy', 'needs-attention',
      'Correction predictions have been running off',
      `Predicted vs actual glucose differed by ${mae.toFixed(1)} mmol/L on average over ${n} corrections — worth rechecking the factor.`,
      n, { mae, tryText: 'Recheck your correction factor in Settings — it may need to be stronger or weaker than what you\'re currently using.' });
  }
  if (mae <= 1.0) {
    return insight('correction-factor-accuracy', 'going-well',
      'Correction predictions are tracking well',
      `Predicted vs actual glucose differed by only ${mae.toFixed(1)} mmol/L on average over ${n} corrections.`,
      n, { mae });
  }
  return insight('correction-factor-accuracy', 'worth-knowing',
    'Correction predictions are roughly in the ballpark',
    `Predicted vs actual glucose differed by ${mae.toFixed(1)} mmol/L on average over ${n} corrections.`,
    n, { mae });
}

// ── 2. Exercise vs rest sensitivity ─────────────────────────
function patternExerciseSensitivity(d) {
  const clean = d.cleanInWindow;
  if (clean.length < 6) return null;

  const isPostExercise = c => (d.workouts || []).some(w => {
    const endMs = toMs(w.endTime);
    return endMs != null && c._ms >= endMs && c._ms <= endMs + 8 * 60 * 60000;
  });

  const postEx = clean.filter(isPostExercise);
  const rest   = clean.filter(c => !isPostExercise(c));
  if (postEx.length < 3 || rest.length < 3) return null;

  const postExAvg = mean(postEx.map(c => c.dropPerUnit));
  const restAvg   = mean(rest.map(c => c.dropPerUnit));
  const pctDiff = restAvg ? ((postExAvg - restAvg) / restAvg) * 100 : 0;

  if (Math.abs(pctDiff) < 15) {
    return insight('exercise-sensitivity', 'worth-knowing',
      'Sensitivity looks similar with or without recent exercise',
      `Correction strength was ${postExAvg.toFixed(2)} mmol/L/u post-exercise (n=${postEx.length}) vs ${restAvg.toFixed(2)} at rest (n=${rest.length}) — no big difference.`,
      clean.length, { postExAvg, restAvg, pctDiff });
  }
  const category = pctDiff > 0 ? 'needs-attention' : 'worth-knowing';
  const direction = pctDiff > 0 ? 'more' : 'less';
  const tryText = pctDiff > 0
    ? 'Consider a smaller correction dose (or a slightly higher target) within a few hours of exercise to avoid overcorrecting.'
    : 'You may need a slightly larger correction than usual soon after exercise to bring glucose down as expected.';
  return insight('exercise-sensitivity', category,
    `You run ${direction} insulin-sensitive after exercise`,
    `Correction strength was ${postExAvg.toFixed(2)} mmol/L/u within 8h of a workout (n=${postEx.length}) vs ${restAvg.toFixed(2)} at rest (n=${rest.length}) — ${Math.abs(pctDiff).toFixed(0)}% ${direction} effective.`,
    clean.length, { postExAvg, restAvg, pctDiff, tryText });
}

// ── 3. Post-workout trajectory (before/during/after) ────────
function patternPostWorkoutTrajectory(d) {
  const workouts = (d.workouts || []).filter(w => w._ms != null);
  if (workouts.length < 2) return null;

  const deltas = { before: [], during: [], after: [] };
  for (const w of workouts) {
    const startMs = w._ms;
    const endMs = toMs(w.endTime) ?? startMs;
    const beforeR = nearestReading(d.readings, startMs - 60 * 60000, 30);
    const startR  = nearestReading(d.readings, startMs, 20);
    const endR    = nearestReading(d.readings, endMs, 20);
    const afterR  = nearestReading(d.readings, endMs + 4 * 60 * 60000, 45);
    if (beforeR && startR) deltas.before.push(startR.value - beforeR.value);
    if (startR && endR)    deltas.during.push(endR.value - startR.value);
    if (endR && afterR)    deltas.after.push(afterR.value - endR.value);
  }

  const n = workouts.length;
  if (deltas.during.length < 2) return null;

  const beforeAvg = mean(deltas.before);
  const duringAvg = mean(deltas.during);
  const afterAvg  = mean(deltas.after);

  const parts = [];
  if (beforeAvg != null) parts.push(`${fmtSigned(beforeAvg)} mmol/L in the hour before (n=${deltas.before.length})`);
  parts.push(`${fmtSigned(duringAvg)} mmol/L during the workout (n=${deltas.during.length})`);
  if (afterAvg != null) parts.push(`${fmtSigned(afterAvg)} mmol/L in the 4h after (n=${deltas.after.length})`);

  const category = (afterAvg != null && afterAvg < -1.5) ? 'needs-attention' : 'worth-knowing';
  const extra = { beforeAvg, duringAvg, afterAvg };
  if (category === 'needs-attention') {
    extra.tryText = 'Consider a small carb top-up in the hours after this type of workout to blunt the delayed drop.';
  }
  return insight('post-workout-trajectory', category,
    'Your typical workout glucose trajectory',
    `On average: ${parts.join(', then ')}.`,
    n, extra);
}
function fmtSigned(v) { return (v >= 0 ? '+' : '') + v.toFixed(1); }

// ── 4. Time-of-day highs/lows ────────────────────────────────
function patternTimeOfDay(d) {
  if (d.readings.length < PATTERN_MIN_READINGS) return null;
  const byHour = Array.from({ length: 24 }, () => []);
  for (const r of d.readings) byHour[hourOfDay(r.ms)].push(r.value);

  const low = d.settings.targetLow, high = d.settings.targetHigh;
  const hourly = byHour.map((vals, h) => {
    if (vals.length < 3) return null;
    const lowPct  = (vals.filter(v => v < low).length / vals.length) * 100;
    const highPct = (vals.filter(v => v > high).length / vals.length) * 100;
    return { hour: h, n: vals.length, lowPct, highPct };
  }).filter(Boolean);
  if (!hourly.length) return null;

  const avgLowPct  = mean(hourly.map(h => h.lowPct));
  const avgHighPct = mean(hourly.map(h => h.highPct));

  const worstLowHour  = hourly.filter(h => h.lowPct  >= Math.max(15, avgLowPct * 2)).sort((a, b) => b.lowPct - a.lowPct)[0];
  const worstHighHour = hourly.filter(h => h.highPct >= Math.max(15, avgHighPct * 2)).sort((a, b) => b.highPct - a.highPct)[0];

  if (!worstLowHour && !worstHighHour) {
    return insight('time-of-day', 'going-well',
      'No hour of day stands out as a problem',
      'Highs and lows are fairly evenly spread across the day rather than clustering at a particular time.',
      d.readings.length);
  }

  const bits = [];
  if (worstLowHour) bits.push(`lows around ${fmtHour(worstLowHour.hour)} (${worstLowHour.lowPct.toFixed(0)}% of readings, n=${worstLowHour.n})`);
  if (worstHighHour) bits.push(`highs around ${fmtHour(worstHighHour.hour)} (${worstHighHour.highPct.toFixed(0)}% of readings, n=${worstHighHour.n})`);

  return insight('time-of-day', 'needs-attention',
    'A specific time of day stands out',
    `More ${bits.join(' and ')} than the rest of the day.`,
    d.readings.length, { worstLowHour, worstHighHour, tryText: `Take a closer look at dosing, meals, or basal coverage around ${worstLowHour ? fmtHour(worstLowHour.hour) : fmtHour(worstHighHour.hour)} to see what's driving it.` });
}
function fmtHour(h) { return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`; }

// ── 5. Dawn phenomenon ───────────────────────────────────────
function patternDawnPhenomenon(d) {
  const days = uniqueDays(d.readings, d.windowStart, d.windowEnd);
  const rises = [];
  for (const dayStartMs of days) {
    const troughReadings = d.readings.filter(r => r.ms >= dayStartMs + 2 * 3600000 && r.ms <= dayStartMs + 5 * 3600000);
    const morningReadings = d.readings.filter(r => r.ms >= dayStartMs + 6.5 * 3600000 && r.ms <= dayStartMs + 8 * 3600000);
    if (!troughReadings.length || !morningReadings.length) continue;

    const troughMin = Math.min(...troughReadings.map(r => r.value));
    const troughAt = troughReadings.find(r => r.value === troughMin).ms;
    // Exclude mornings confounded by a meal/correction between trough and the morning reading
    const confounded = (d.boluses || []).some(b => {
      const bms = toMs(b.time);
      return bms != null && bms >= troughAt && bms <= dayStartMs + 8 * 3600000 && (Number(b.carbs) > 0 || Number(b.units) > 0);
    });
    if (confounded) continue;

    const morningAvg = mean(morningReadings.map(r => r.value));
    rises.push(morningAvg - troughMin);
  }

  if (rises.length < 3) return null;
  const avgRise = mean(rises);
  const positiveDays = rises.filter(r => r > 1.0).length;

  if (avgRise >= 1.5 && positiveDays >= Math.ceil(rises.length * 0.6)) {
    const category = avgRise >= 3 ? 'needs-attention' : 'worth-knowing';
    return insight('dawn-phenomenon', category,
      'Dawn phenomenon — an unprompted early-morning rise',
      `Glucose rose ${avgRise.toFixed(1)} mmol/L on average between the overnight trough and ~7am, with no meal or dose in between, on ${positiveDays}/${rises.length} mornings.`,
      rises.length, { avgRise, positiveDays, tryText: 'Ask your care team about a small pre-emptive dose or basal adjustment timed before the rise.' });
  }
  return insight('dawn-phenomenon', 'going-well',
    'No consistent dawn phenomenon',
    `Early-morning glucose was flat or fell on most of the ${rises.length} mornings checked.`,
    rises.length, { avgRise });
}
function uniqueDays(readings, startMs, endMs) {
  const days = [];
  for (let t = Math.floor(startMs / DAY_MS) * DAY_MS; t < endMs; t += DAY_MS) days.push(t);
  return days;
}

// ── 6. Hypo/hyper clustering by 4h window ────────────────────
function patternClusteringByWindow(d) {
  if (d.readings.length < PATTERN_MIN_READINGS) return null;
  const buckets = Array.from({ length: 6 }, () => ({ low: 0, high: 0, n: 0 }));
  const low = d.settings.targetLow, high = d.settings.targetHigh;
  for (const r of d.readings) {
    const b = Math.floor(hourOfDay(r.ms) / 4);
    buckets[b].n++;
    if (r.value < low) buckets[b].low++;
    if (r.value > high) buckets[b].high++;
  }
  const labeled = buckets.map((b, i) => ({
    label: `${String(i * 4).padStart(2, '0')}:00–${String(i * 4 + 4).padStart(2, '0')}:00`,
    n: b.n,
    lowPct: b.n ? (b.low / b.n) * 100 : 0,
    highPct: b.n ? (b.high / b.n) * 100 : 0,
  })).filter(b => b.n >= 3);
  if (!labeled.length) return null;

  const worst = [...labeled].sort((a, b) => (b.lowPct + b.highPct) - (a.lowPct + a.highPct))[0];
  if (worst.lowPct < 10 && worst.highPct < 25) {
    return insight('4h-clustering', 'going-well',
      'No 4-hour block stands out for highs or lows',
      'Out-of-range readings are spread fairly evenly across the day\'s 4-hour blocks.',
      d.readings.length);
  }
  return insight('4h-clustering', worst.lowPct >= 15 ? 'needs-attention' : 'worth-knowing',
    `${worst.label} is your roughest 4-hour block`,
    `${worst.lowPct.toFixed(0)}% low, ${worst.highPct.toFixed(0)}% high in that window (n=${worst.n}).`,
    d.readings.length, { worst, allBuckets: labeled, tryText: `Take a closer look at dosing and meals around ${worst.label} to see what's driving it.` });
}

// ── 7. Meal-size outcome tertiles ────────────────────────────
function patternMealSizeTertiles(d) {
  const meals = (d.boluses || []).filter(b => b._ms != null && Number(b.carbs) > 0);
  if (meals.length < 9) return null;

  const withOutcome = meals.map(m => {
    const preR = nearestReading(d.readings, m._ms, 20);
    const window = d.readings.filter(r => r.ms >= m._ms && r.ms <= m._ms + 3 * 3600000);
    if (!preR || !window.length) return null;
    const peak = Math.max(...window.map(r => r.value));
    return { carbs: Number(m.carbs), rise: peak - preR.value };
  }).filter(Boolean);
  if (withOutcome.length < 9) return null;

  const sorted = [...withOutcome].sort((a, b) => a.carbs - b.carbs);
  const third = Math.floor(sorted.length / 3);
  const tertiles = {
    small:  sorted.slice(0, third),
    medium: sorted.slice(third, third * 2),
    large:  sorted.slice(third * 2),
  };
  const stats = Object.fromEntries(Object.entries(tertiles).map(([k, v]) =>
    [k, { n: v.length, avgCarbs: mean(v.map(x => x.carbs)), avgRise: mean(v.map(x => x.rise)) }]));

  const largeVsSmall = stats.large.avgRise - stats.small.avgRise;
  const category = largeVsSmall > 3 ? 'needs-attention' : 'worth-knowing';
  const extra = { stats, largeVsSmall };
  if (largeVsSmall > 1.5) {
    extra.tryText = 'Consider a slightly stronger dose (or a small pre-bolus) for your larger meals.';
  }
  return insight('meal-size-tertiles', category,
    'Bigger meals spike disproportionately' ,
    `Small meals (~${stats.small.avgCarbs.toFixed(0)}g, n=${stats.small.n}) rise ${stats.small.avgRise.toFixed(1)} mmol/L on average; `
      + `large meals (~${stats.large.avgCarbs.toFixed(0)}g, n=${stats.large.n}) rise ${stats.large.avgRise.toFixed(1)} mmol/L.`,
    withOutcome.length, extra);
}

// ── 8. Time-in-range + CV ────────────────────────────────────
function patternTimeInRangeCV(d) {
  if (d.readings.length < PATTERN_MIN_READINGS) return null;
  const tir = timeInRange(d.readings, d.settings.targetLow, d.settings.targetHigh);
  const stats = glucoseStats(d.readings);
  if (!tir || !stats || stats.cv == null) return null;

  const goodTir = tir.pctInRange >= 70;
  const goodCv = stats.cv <= CV_TARGET_MAX_PCT;
  const category = goodTir && goodCv ? 'going-well' : (!goodCv || tir.pctInRange < 50) ? 'needs-attention' : 'worth-knowing';

  const extra = { tir, cv: stats.cv };
  if (category === 'needs-attention') {
    extra.tryText = 'Worth reviewing your basal and correction settings, or checking in with your care team.';
  }
  return insight('tir-cv', category,
    `${tir.pctInRange.toFixed(0)}% time-in-range this week`,
    `${tir.pctBelow.toFixed(0)}% below, ${tir.pctAbove.toFixed(0)}% above target. Variability (CV) is ${stats.cv.toFixed(0)}% (goal ≤${CV_TARGET_MAX_PCT}%).`,
    d.readings.length, extra);
}

// ── 9. Sensitivity drift over time ───────────────────────────
function patternSensitivityDrift(d) {
  const clean = [...d.cleanInWindow].sort((a, b) => a._ms - b._ms);
  if (clean.length < 6) return null;
  const mid = Math.floor(clean.length / 2);
  const earlier = clean.slice(0, mid);
  const later = clean.slice(mid);
  if (earlier.length < 3 || later.length < 3) return null;

  const earlierAvg = mean(earlier.map(c => c.dropPerUnit));
  const laterAvg = mean(later.map(c => c.dropPerUnit));
  const pctChange = earlierAvg ? ((laterAvg - earlierAvg) / earlierAvg) * 100 : 0;

  if (Math.abs(pctChange) < 15) {
    return insight('sensitivity-drift', 'going-well',
      'Correction factor has been stable',
      `${earlierAvg.toFixed(2)} → ${laterAvg.toFixed(2)} mmol/L/u across the week — no meaningful drift.`,
      clean.length, { earlierAvg, laterAvg, pctChange });
  }
  const direction = pctChange > 0 ? 'more sensitive' : 'less sensitive';
  return insight('sensitivity-drift', Math.abs(pctChange) >= 30 ? 'needs-attention' : 'worth-knowing',
    `Insulin sensitivity is trending ${direction}`,
    `Correction strength moved from ${earlierAvg.toFixed(2)} to ${laterAvg.toFixed(2)} mmol/L/u across the week (${pctChange > 0 ? '+' : ''}${pctChange.toFixed(0)}%).`,
    clean.length, { earlierAvg, laterAvg, pctChange, tryText: `Consider updating your correction factor to closer to ${laterAvg.toFixed(2)} mmol/L/u.` });
}

// ── 10. Basal timing drift ───────────────────────────────────
// Meaningful for MDI-style basal (one Lantus/Levemir-type injection a
// day, where "same time each day" is a real signal) — meaningless for
// pump basal, which is delivered continuously all day by design and
// will always show a huge spread of clock-times. Detect that case (a
// short median gap between consecutive doses) and withhold instead of
// reporting the pump's own continuous delivery as "drift".
const BASAL_CONTINUOUS_GAP_MINUTES = 20;
function patternBasalTimingDrift(d) {
  const doses = windowFilter(d.basalDoses, 'time', d.windowStart, d.windowEnd).sort((a, b) => a._ms - b._ms);
  if (doses.length < 4) return null;

  const gaps = [];
  for (let i = 1; i < doses.length; i++) gaps.push((doses[i]._ms - doses[i - 1]._ms) / 60000);
  const medianGap = median(gaps);
  if (medianGap != null && medianGap <= BASAL_CONTINUOUS_GAP_MINUTES) return null;

  const times = doses.map(b => minutesSinceMidnight(b._ms));
  const sd = stddev(times);
  if (sd == null) return null;

  if (sd <= 15) {
    return insight('basal-timing-drift', 'going-well',
      'Basal dose timing has been consistent',
      `Dose time varied by about ±${sd.toFixed(0)} minutes across ${doses.length} doses.`,
      doses.length, { sd });
  }
  return insight('basal-timing-drift', sd > 60 ? 'needs-attention' : 'worth-knowing',
    'Basal dose timing has been drifting',
    `Dose time varied by about ±${sd.toFixed(0)} minutes across ${doses.length} doses — inconsistent timing can affect overnight coverage.`,
    doses.length, { sd, tryText: 'Try setting a fixed daily alarm for your basal dose to tighten up the timing.' });
}

// ── 11. Correction-stacking that caused lows ─────────────────
function patternStackingCausedLows(d) {
  const clean = d.correctionsInWindow.filter(c => Number(c.units) > 0 && c._ms != null);
  if (clean.length < 2) return null;

  const events = [];
  for (const c of clean) {
    const stacked = detectStackingCaution(d.boluses, d.correctionsInWindow, c._ms, insulinCurveOpts(d.settings))
      .filter(s => s.time !== c._ms); // don't flag the dose against itself
    if (!stacked.length) continue;
    const followUp = d.readings.filter(r => r.ms >= c._ms && r.ms <= c._ms + 3 * 3600000);
    const wentLow = followUp.some(r => r.value < d.settings.targetLow);
    if (wentLow) events.push({ time: c._ms, units: c.units });
  }
  if (!events.length) return null;
  return insight('stacking-caused-lows', 'needs-attention',
    'Stacked corrections have led to lows',
    `${events.length} correction${events.length === 1 ? '' : 's'} given while a previous dose was still active were followed by a low within 3h.`,
    clean.length, { events, tryText: 'Check IOB before correcting again, and consider waiting longer between corrections.' });
}

// ── 12. Evening-exercise → overnight-lows ────────────────────
function patternEveningExerciseOvernightLows(d) {
  const eveningWorkouts = (d.workouts || []).filter(w => w._ms != null && hourOfDay(w._ms) >= 17);
  if (eveningWorkouts.length < 2) return null;

  const overnightLow = (dayStartMs) => {
    const overnight = d.readings.filter(r => r.ms >= dayStartMs + 20 * 3600000 && r.ms <= dayStartMs + 30 * 3600000);
    return overnight.length ? overnight.some(r => r.value < d.settings.targetLow) : null;
  };

  const exerciseNights = [];
  for (const w of eveningWorkouts) {
    const dayStart = Math.floor(w._ms / DAY_MS) * DAY_MS;
    const low = overnightLow(dayStart);
    if (low != null) exerciseNights.push(low);
  }
  if (exerciseNights.length < 2) return null;

  const allDays = uniqueDays(d.readings, d.windowStart, d.windowEnd);
  const exerciseDaySet = new Set(eveningWorkouts.map(w => Math.floor(w._ms / DAY_MS) * DAY_MS));
  const restNights = allDays.filter(dayMs => !exerciseDaySet.has(dayMs))
    .map(overnightLow).filter(v => v != null);

  const exerciseLowRate = mean(exerciseNights.map(v => (v ? 1 : 0))) * 100;
  const restLowRate = restNights.length ? mean(restNights.map(v => (v ? 1 : 0))) * 100 : null;

  if (restLowRate != null && exerciseLowRate <= restLowRate + 10) {
    return insight('evening-exercise-overnight-lows', 'going-well',
      'Evening exercise isn\'t causing overnight lows',
      `Overnight lows happened ${exerciseLowRate.toFixed(0)}% of the time after evening exercise (n=${exerciseNights.length}) vs ${restLowRate.toFixed(0)}% otherwise.`,
      exerciseNights.length, { exerciseLowRate, restLowRate });
  }
  return insight('evening-exercise-overnight-lows', 'needs-attention',
    'Evening exercise has been linked to overnight lows',
    `Overnight lows happened ${exerciseLowRate.toFixed(0)}% of the time after evening exercise (n=${exerciseNights.length})`
      + (restLowRate != null ? ` vs ${restLowRate.toFixed(0)}% on other nights.` : ', with too few other nights to compare.'),
    exerciseNights.length, { exerciseLowRate, restLowRate, tryText: 'Consider a bedtime snack or a reduced evening basal dose after evening workouts.' });
}

// ── 13. Hypo recovery (time to safety + overshoot-past-10) ──
function patternHypoRecovery(d) {
  const low = d.settings.targetLow;
  const episodes = [];
  let i = 0;
  while (i < d.readings.length) {
    if (d.readings[i].value < low) {
      const onset = d.readings[i];
      let j = i;
      while (j < d.readings.length && d.readings[j].value < low) j++;
      const recovery = d.readings[j]; // first reading back >= low, if any
      episodes.push({ onset, recovery });
      i = j + 1;
    } else {
      i++;
    }
  }
  const withRecovery = episodes.filter(e => e.recovery);
  if (withRecovery.length < 3) return null;

  const timesToSafety = withRecovery.map(e => minutesBetween(e.onset.ms, e.recovery.ms));
  const avgTimeToSafety = mean(timesToSafety);

  let overshoots = 0;
  for (const e of withRecovery) {
    const followUp = d.readings.filter(r => r.ms >= e.recovery.ms && r.ms <= e.recovery.ms + 2 * 3600000);
    if (followUp.some(r => r.value > HYPER_FIXED_MMOL)) overshoots++;
  }
  const overshootPct = (overshoots / withRecovery.length) * 100;

  const category = (avgTimeToSafety > 45 || overshootPct > 40) ? 'needs-attention'
    : (avgTimeToSafety <= 25 && overshootPct <= 20) ? 'going-well' : 'worth-knowing';

  const extra = { avgTimeToSafety, overshootPct };
  if (category === 'needs-attention') {
    const tryBits = [];
    if (avgTimeToSafety > 45) tryBits.push('treating lows with faster-acting carbs (e.g. glucose tablets or juice) to bring recovery time down');
    if (overshootPct > 40) tryBits.push('using a smaller hypo treatment to avoid rebounding high afterwards');
    extra.tryText = tryBits.join(', and ') + '.';
  }
  return insight('hypo-recovery', category,
    'How lows have been recovering',
    `Average ${avgTimeToSafety.toFixed(0)} min back to target range across ${withRecovery.length} episodes; `
      + `${overshootPct.toFixed(0)}% overshot past ${HYPER_FIXED_MMOL} within 2h of recovering.`,
    withRecovery.length, extra);
}

// ── 14. Delayed-rise meals (fat/protein signature) ───────────
function patternDelayedRiseMeals(d) {
  // Sorted so each meal's trailing window can be capped at the NEXT meal's
  // start — without this, a 6h window routinely reaches into the next
  // real meal (breakfast→lunch is often only ~5h), and that meal's own
  // ordinary rise gets misread as "this meal's" delayed second climb.
  const meals = (d.boluses || []).filter(b => b._ms != null && Number(b.carbs) > 0).sort((a, b) => a._ms - b._ms);
  if (meals.length < 4) return null;

  const flagged = [];
  let checked = 0;
  for (let i = 0; i < meals.length; i++) {
    const m = meals[i];
    const nextMealMs = meals[i + 1]?._ms ?? Infinity;
    const windowEnd = Math.min(m._ms + 6 * 3600000, nextMealMs);
    const trailing = d.readings.filter(r => r.ms >= m._ms && r.ms <= windowEnd);
    if (trailing.length < 6) continue;
    checked++;

    // First climb/peak within 0-2.5h, then a local minimum, then a second
    // climb of >=1.5 mmol/L starting somewhere in the 2.5-6h window.
    const early = trailing.filter(r => r.ms <= m._ms + 2.5 * 3600000);
    const late  = trailing.filter(r => r.ms > m._ms + 2.5 * 3600000);
    if (!early.length || late.length < 2) continue;

    const troughInLate = late.reduce((min, r) => (r.value < min.value ? r : min), late[0]);
    const afterTrough = late.filter(r => r.ms >= troughInLate.ms);
    if (afterTrough.length < 2) continue;
    const secondPeak = Math.max(...afterTrough.map(r => r.value));
    const secondClimb = secondPeak - troughInLate.value;

    // A real second carb wave should push glucose meaningfully ABOVE where
    // it started, not just recover toward it — without this, insulin
    // simply wearing off toward the end of its duration (glucose drifting
    // back up to an ordinary baseline as suppression fades) looks
    // identical to a genuine delayed rise for basically every meal.
    const preMealBaseline = nearestReading(d.readings, m._ms, 30);
    const risesAboveBaseline = preMealBaseline && (secondPeak - preMealBaseline.value) >= 1.0;

    // If the late-window trough was itself a genuine low, a MODEST climb
    // out of it is far more parsimoniously a counter-regulatory rebound
    // (the body's own hormone response to a low, typically a few mmol/L)
    // than a second wave of food — same curve shape, different real
    // cause. But a LARGE climb (way beyond plausible hormonal rebound)
    // even from a low trough is still much more likely a genuine second
    // carb wave, so only modest rebounds get excluded, not big ones.
    const low = d.settings?.targetLow ?? HYPO_FIXED_MMOL;
    const troughWasGenuineLow = troughInLate.value < low;
    const isPlausibleReboundOnly = troughWasGenuineLow && secondClimb < REBOUND_PLAUSIBLE_MAX_MMOL;

    if (secondClimb >= 1.5 && risesAboveBaseline && !isPlausibleReboundOnly) {
      flagged.push({ time: m._ms, mealName: m.mealName || null, secondClimb });
    }
  }
  if (checked < 4) return null;
  if (!flagged.length) {
    return insight('delayed-rise-meals', 'going-well',
      'No delayed-rise (fat/protein) meals spotted',
      `Checked ${checked} meals with a full 6h glucose trail — none showed a second climb late in the window.`,
      checked);
  }
  const names = [...new Set(flagged.map(f => f.mealName).filter(Boolean))];
  return insight('delayed-rise-meals', 'worth-knowing',
    'Some meals show a delayed second rise',
    `${flagged.length}/${checked} meals climbed again 2.5–6h out (the fat/protein signature)`
      + (names.length ? ` — recurring in: ${names.join(', ')}.` : '.'),
    checked, { flagged, tryText: 'For those meals, try an extended/dual-wave bolus (or splitting the dose) to cover the second rise.' });
}

// ── Orchestrator ──────────────────────────────────────────────
function analyzePatterns(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - PATTERN_LOOKBACK_DAYS * DAY_MS;
  const windowEnd = nowMs;

  const readings = sortedReadings(glucoseHistory, windowStart, windowEnd);
  if (readings.length < PATTERN_MIN_READINGS) {
    return {
      sufficient: false,
      readingCount: readings.length,
      minReadingsNeeded: PATTERN_MIN_READINGS,
      needsAttention: [], goingWell: [], worthKnowing: [],
    };
  }

  const boluses_ = windowFilter(boluses, 'time', windowStart, windowEnd);
  const correctionsInWindow = windowFilter(corrections, 'time', windowStart, windowEnd);
  const resolvedInWindow = resolveCorrections(correctionsInWindow, glucoseHistory, boluses, now)
    .map(c => ({ ...c, _ms: toMs(c.time) }));
  const cleanInWindow = resolvedInWindow.filter(c => c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit));
  const workouts = windowFilter(activities.workouts, 'startTime', windowStart, windowEnd);

  const d = {
    readings, boluses: boluses_, correctionsInWindow, resolvedInWindow, cleanInWindow,
    workouts, basalDoses, settings, windowStart, windowEnd,
  };

  const checks = [
    patternCorrectionAccuracy, patternExerciseSensitivity, patternPostWorkoutTrajectory,
    patternTimeOfDay, patternDawnPhenomenon, patternClusteringByWindow,
    patternMealSizeTertiles, patternTimeInRangeCV, patternSensitivityDrift,
    patternBasalTimingDrift, patternStackingCausedLows, patternEveningExerciseOvernightLows,
    patternHypoRecovery, patternDelayedRiseMeals,
  ];

  const results = checks.map(fn => {
    try { return fn(d); } catch { return null; }
  }).filter(Boolean);

  return {
    sufficient: true,
    readingCount: readings.length,
    windowStart, windowEnd,
    needsAttention: results.filter(r => r.category === 'needs-attention'),
    goingWell:      results.filter(r => r.category === 'going-well'),
    worthKnowing:   results.filter(r => r.category === 'worth-knowing'),
  };
}

/* ═══════════════════════════════════════════════════════════
   STAGE 4 — Live features
   Hypo forecast, per-workout-type profiles + live alert, pre-workout
   advisor, "what if I…" simulator, preventative carb advice.
   Deliberately pessimistic where spec says so — a forecast that misses
   a low by crying wolf is far cheaper than one that misses a real one.
   ═══════════════════════════════════════════════════════════ */

const WORKOUT_DROP_WINDOW_HOURS   = 8;
const WORKOUT_MIN_SESSIONS_RELIABLE = 3;  // minimum n before "reliable drop" is assessed at all
const WORKOUT_MIN_SESSIONS_PERSONAL = 2;  // minimum n before the pre-workout advisor trusts personal data
const HYPO_FORECAST_HORIZON_MIN   = 120;
const TIME_OF_DAY_LOOKBACK_DAYS   = 14;
const TIME_OF_DAY_BUMP_LOW_COUNT  = 2;
const PREVENTATIVE_CARB_TARGET    = 5.0;  // mmol/L — the trough level preventative carbs aim to lift to
const FAST_RESCUE_MINUTES         = 45;   // trough this soon (or already below target-low) → fast carbs, not slow

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ── Per-workout-type profiles ────────────────────────────────
   Pools sessions of the EXACT same workoutType, comparing pre-workout
   baseline glucose to the lowest reading in the 8h after the session
   ends. "Reliable drop" needs both a majority pattern (>=60% of
   sessions drop more than 1.5 mmol/L) and a meaningful typical size
   (median >=1.5) — a single outlier session shouldn't count as a
   pattern, hence the separate minimum-sample gate below. */
function buildWorkoutTypeProfiles(workouts, glucoseHistory) {
  const readings = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && !Number.isNaN(r.value))
    .sort((a, b) => a.ms - b.ms);

  const byType = {};
  for (const w of workouts || []) {
    const type = w.workoutType || 'Unknown';
    const startMs = toMs(w.startTime);
    const endMs = toMs(w.endTime) ?? startMs;
    if (startMs == null) continue;

    const baseline = nearestReading(readings, startMs, 45);
    const window = readings.filter(r => r.ms >= endMs && r.ms <= endMs + WORKOUT_DROP_WINDOW_HOURS * 3600000);
    if (!baseline || !window.length) continue;

    const nadirReading = window.reduce((min, r) => (r.value < min.value ? r : min), window[0]);
    const drop = baseline.value - nadirReading.value;
    const timeToNadirMin = minutesBetween(endMs, nadirReading.ms);

    if (!byType[type]) byType[type] = [];
    byType[type].push({ startMs, endMs, baseline: baseline.value, nadir: nadirReading.value, drop, timeToNadirMin });
  }

  const profiles = {};
  for (const [type, sessions] of Object.entries(byType)) {
    const n = sessions.length;
    const drops = sessions.map(s => s.drop);
    const medianDrop = median(drops);
    const pctOverThreshold = (sessions.filter(s => s.drop > 1.5).length / n) * 100;
    const medianTimeToNadirMin = median(sessions.map(s => s.timeToNadirMin));

    const enoughSample = n >= WORKOUT_MIN_SESSIONS_RELIABLE;
    const isReliableDrop = enoughSample && pctOverThreshold >= 60 && medianDrop >= 1.5;

    profiles[type] = {
      workoutType: type, n, medianDrop, pctSessionsDropOver1_5: pctOverThreshold,
      medianTimeToNadirMin, enoughSample, isReliableDrop, drops,
    };
  }
  return profiles;
}

// A live "you're in the drop window" alert for any workout whose 8h
// post-session window is currently active and has a reliable drop
// pattern behind it.
function workoutLiveAlert(profiles, workouts, now = Date.now()) {
  const nowMs = toMs(now);
  const active = (workouts || [])
    .map(w => ({ w, endMs: toMs(w.endTime) ?? toMs(w.startTime) }))
    .filter(({ endMs }) => endMs != null && endMs <= nowMs && nowMs <= endMs + WORKOUT_DROP_WINDOW_HOURS * 3600000)
    .sort((a, b) => b.endMs - a.endMs);

  if (!active.length) return null;
  const { w, endMs } = active[0];
  const profile = profiles[w.workoutType || 'Unknown'];
  if (!profile || !profile.isReliableDrop) return null;

  const hoursSinceEnd = minutesBetween(endMs, nowMs) / 60;
  return {
    workoutType: w.workoutType,
    hoursSinceEnd,
    n: profile.n,
    medianDrop: profile.medianDrop,
    medianTimeToNadirMin: profile.medianTimeToNadirMin,
    message: `Past ${w.workoutType} sessions (n=${profile.n}) tend to drop ~${profile.medianDrop.toFixed(1)} mmol/L over the following ${WORKOUT_DROP_WINDOW_HOURS}h — worth watching.`,
  };
}

// The remaining chunk of a workout's typical drop still to come within
// the next `horizonMin` — a simple proportional-over-8h heuristic, not
// a real absorption curve, so it's kept openly approximate.
function openWorkoutDropWithin(profiles, workouts, now, horizonMin) {
  const alert = workoutLiveAlert(profiles, workouts, now);
  if (!alert) return 0;
  const hoursRemaining = Math.max(0, WORKOUT_DROP_WINDOW_HOURS - alert.hoursSinceEnd);
  const horizonHours = Math.min(horizonMin / 60, hoursRemaining);
  return alert.medianDrop * (horizonHours / WORKOUT_DROP_WINDOW_HOURS);
}

/* ── 2h hypo forecast ──────────────────────────────────────────
   effective − insulinAction(120) − openWorkoutDrop(120) + carbAbsorption(120),
   converted to mmol/L via the personal correction factor / carb ratio.
   Withheld (not faked with a generic factor) when there isn't yet a
   trustworthy personal factor — consistent with "withhold rather than
   fake precision." Deliberately pessimistic: ties in tier assignment
   round toward the more cautious tier, and a time-of-day with a recent
   history of lows bumps the tier up regardless of the raw number. */
function hypoForecast2h(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const curveOpts = insulinCurveOpts(settings);

  const ctx = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  if (ctx.stale || ctx.effectiveGlucose == null) {
    return { tier: null, withheldReason: 'stale-reading', context: ctx };
  }

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);
  if (factorResult.factor == null) {
    return { tier: null, withheldReason: 'insufficient-history', context: ctx, factor: factorResult };
  }
  const factor = factorResult.factor;
  const carbRatio = Number(settings.carbRatio) || null;

  const insulinActionUnits = insulinActionWithin(boluses, corrections, nowMs, HYPO_FORECAST_HORIZON_MIN, curveOpts);
  const carbAbsorptionGrams = carbAbsorptionWithin(boluses, nowMs, HYPO_FORECAST_HORIZON_MIN);

  const insulinDropMmol = insulinActionUnits * factor;
  const carbRiseMmol = carbRatio ? (carbAbsorptionGrams / carbRatio) * factor : 0;

  const workoutProfiles = buildWorkoutTypeProfiles(activities.workouts, glucoseHistory);
  const openWorkoutDropMmol = openWorkoutDropWithin(workoutProfiles, activities.workouts, nowMs, HYPO_FORECAST_HORIZON_MIN);

  const forecastGlucose = ctx.effectiveGlucose - insulinDropMmol + carbRiseMmol - openWorkoutDropMmol;

  const low = Number(settings.targetLow) || 4.5;
  let tier;
  if (forecastGlucose <= low - 1) tier = 'high';
  else if (forecastGlucose <= low) tier = 'moderate';
  else if (forecastGlucose <= low + 1.5) tier = 'low';
  else tier = 'minimal';

  // Bump a tier if this time-of-day has had >=2 lows in recent history —
  // deliberately pessimistic per spec, regardless of how the raw number lands.
  const lookbackStart = nowMs - TIME_OF_DAY_LOOKBACK_DAYS * DAY_MS;
  const hourNow = hourOfDay(nowMs);
  const sameHourLows = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && r.ms >= lookbackStart && r.ms <= nowMs && hourOfDay(r.ms) === hourNow && r.value < low)
    .length;
  const bumped = sameHourLows >= TIME_OF_DAY_BUMP_LOW_COUNT;
  if (bumped) {
    const order = ['minimal', 'low', 'moderate', 'high'];
    tier = order[Math.min(order.length - 1, order.indexOf(tier) + 1)];
  }

  return {
    tier,
    bumpedForTimeOfDay: bumped,
    forecastGlucose,
    effectiveGlucose: ctx.effectiveGlucose,
    insulinDropMmol, carbRiseMmol, openWorkoutDropMmol,
    factor, factorSampleSize: factorResult.sampleSize,
    withheldReason: null,
  };
}

// Same model as hypoForecast2h, generalized into a curve for charting —
// projected glucose at each step from now out to the horizon, using
// active IOB/COB decay against the resolved correction factor. Openly
// approximate (a straight population-curve projection, not a real
// model-predictive forecast) and deliberately not extended past 2-3h,
// where compounding assumptions make it far less trustworthy.
function projectedGlucoseCurve(input, now = Date.now(), horizonMinutes = HYPO_FORECAST_HORIZON_MIN, stepMinutes = 15) {
  const { glucoseHistory = [], boluses = [], corrections = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const curveOpts = insulinCurveOpts(settings);

  const ctx = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  if (ctx.stale || ctx.effectiveGlucose == null) return [];

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);
  if (factorResult.factor == null) return [];

  const carbRatio = Number(settings.carbRatio) || null;
  const points = [];
  for (let t = 0; t <= horizonMinutes; t += stepMinutes) {
    const insulinDropMmol = insulinActionWithin(boluses, corrections, nowMs, t, curveOpts) * factorResult.factor;
    const carbAbsorptionGrams = carbAbsorptionWithin(boluses, nowMs, t);
    const carbRiseMmol = carbRatio ? (carbAbsorptionGrams / carbRatio) * factorResult.factor : 0;
    const value = Math.max(1, ctx.effectiveGlucose - insulinDropMmol + carbRiseMmol);
    points.push({ ms: nowMs + t * 60000, minutesFromNow: t, value });
  }
  return points;
}

/* ── Pre-workout advisor ──────────────────────────────────────
   Personal profile if the exact workout type has >=2 logged sessions;
   otherwise a clearly-labelled generic intensity-class default so the
   person never mistakes a population guess for their own data. */
const INTENSITY_CLASS_KEYWORDS = [
  { intensityClass: 'high-intensity',   keywords: ['hiit', 'sprint', 'crossfit', 'interval'] },
  { intensityClass: 'cardio-endurance', keywords: ['run', 'cycle', 'bike', 'swim', 'row', 'cardio'] },
  // Includes fitl00p's own split_type vocabulary (Push/Pull/Legs/Full Body)
  // alongside the generic strength-training keywords, so a workout logged
  // that way (not free-text "Weightlifting" etc.) still gets a sensible
  // generic default instead of "unclassified".
  { intensityClass: 'strength',         keywords: ['weight', 'strength', 'lift', 'resistance', 'push', 'pull', 'legs', 'full body'] },
  { intensityClass: 'low-intensity',    keywords: ['walk', 'yoga', 'stretch'] },
];
const GENERIC_INTENSITY_DEFAULTS = {
  'high-intensity':   { expectedDropRange: '1–3 mmol/L, sometimes a rise first', note: 'Short, intense efforts can spike glucose before it falls.' },
  'cardio-endurance':  { expectedDropRange: '2–4 mmol/L', note: 'Sustained aerobic effort typically drops glucose steadily.' },
  'strength':          { expectedDropRange: '0.5–2 mmol/L', note: 'Usually a milder, slower drop than cardio.' },
  'low-intensity':     { expectedDropRange: '0.5–1.5 mmol/L', note: 'Gentle effort, typically a small gradual drop.' },
  'unclassified':      { expectedDropRange: 'unknown', note: 'Not enough info to even guess a population default.' },
};
function classifyIntensity(workoutType) {
  const lower = String(workoutType || '').toLowerCase();
  for (const { intensityClass, keywords } of INTENSITY_CLASS_KEYWORDS) {
    if (keywords.some(k => lower.includes(k))) return intensityClass;
  }
  return 'unclassified';
}

function preWorkoutAdvisor(input, workoutType, now = Date.now()) {
  const { activities = {}, glucoseHistory = [] } = input || {};
  const profiles = buildWorkoutTypeProfiles(activities.workouts, glucoseHistory);
  const profile = profiles[workoutType];

  if (profile && profile.n >= WORKOUT_MIN_SESSIONS_PERSONAL) {
    return {
      source: 'personal',
      workoutType,
      n: profile.n,
      medianDrop: profile.medianDrop,
      medianTimeToNadirMin: profile.medianTimeToNadirMin,
      isReliableDrop: profile.isReliableDrop,
    };
  }

  const intensityClass = classifyIntensity(workoutType);
  return {
    source: 'generic-default',
    workoutType,
    intensityClass,
    ...GENERIC_INTENSITY_DEFAULTS[intensityClass],
  };
}

/* ── "What if I…" live simulator ───────────────────────────────
   Unlike preWorkoutAdvisor's pooled stats, this anchors the projection
   to the CURRENT reading and active IOB, then applies the expected drop
   for the chosen activity — personal per-session range when there's
   enough history for that exact type, else a duration/intensity-scaled
   generic estimate. Surfaces a delayed-low-risk read and, when the
   projected range dips into hypo territory, a preventative carb
   suggestion via the same math preventativeCarbAdvice already uses. */
const SIMULATE_DROP_PER_30MIN = { light: 0.5, moderate: 1.0, vigorous: 1.8 };
const SIMULATE_DURATION_SOFT_CAP_MIN = 90;   // beyond this, extra duration adds less (diminishing returns)
const SIMULATE_DURATION_OVERAGE_FACTOR = 0.3;
const SIMULATE_RANGE_SPREAD_PCT = 0.35;      // generic-estimate uncertainty band, +/- around the midpoint
const SIMULATE_WATCH_WINDOW_GENERIC = '1–4h after finishing';
const SIMULATE_CARB_TROUGH_ETA_DEFAULT_MIN = 60; // used for the fast-rescue-vs-slow-buffer call when no personal timeToNadir exists
const SIMULATE_PROJECTION_FLOOR_MMOL = 1.5; // display floor — a raw drop-estimate arithmetic can push well below what's physiologically real for long/vigorous inputs

// Shared by workoutSimulate and the "unplug" pump-suspend simulator below:
// personal per-session drop range once there's enough history for the
// exact activity type, else a duration/intensity-scaled generic estimate.
function estimateExerciseDrop(activities, glucoseHistory, workoutType, durationMin, intensity) {
  const profiles = buildWorkoutTypeProfiles(activities.workouts, glucoseHistory);
  const profile = profiles[workoutType];

  if (profile && profile.n >= WORKOUT_MIN_SESSIONS_PERSONAL && profile.drops?.length) {
    return {
      dropLow: Math.min(...profile.drops),
      dropHigh: Math.max(...profile.drops),
      source: 'personal',
      sampleSize: profile.n,
      timeToNadirMin: profile.medianTimeToNadirMin,
    };
  }
  const perMin = (SIMULATE_DROP_PER_30MIN[intensity] || SIMULATE_DROP_PER_30MIN.light) / 30;
  const effectiveDurationMin = Math.min(durationMin, SIMULATE_DURATION_SOFT_CAP_MIN)
    + Math.max(0, durationMin - SIMULATE_DURATION_SOFT_CAP_MIN) * SIMULATE_DURATION_OVERAGE_FACTOR;
  const dropMid = perMin * effectiveDurationMin;
  return {
    dropLow: dropMid * (1 - SIMULATE_RANGE_SPREAD_PCT),
    dropHigh: dropMid * (1 + SIMULATE_RANGE_SPREAD_PCT),
    source: 'generic',
    sampleSize: 0,
    timeToNadirMin: null, // unknown — generic watch window used instead
  };
}

function workoutSimulate(input, opts = {}, now = Date.now()) {
  const { workoutType, durationMin = 30, intensity = 'light' } = opts;
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};

  const ctx = dosingContext(input, now);
  if (ctx.stale || ctx.currentGlucose == null) {
    return { withheldReason: 'stale-reading', staleMessage: ctx.staleMessage };
  }

  const { dropLow, dropHigh, source, sampleSize, timeToNadirMin } =
    estimateExerciseDrop(activities, glucoseHistory, workoutType, durationMin, intensity);

  const projectedLow = Math.max(SIMULATE_PROJECTION_FLOOR_MMOL, ctx.currentGlucose - dropHigh);
  const projectedHigh = Math.max(projectedLow, ctx.currentGlucose - dropLow);

  const low = Number(settings.targetLow) || HYPO_FIXED_MMOL;
  const risk = projectedLow < low ? 'high' : projectedLow < low + 1.0 ? 'medium' : 'low';
  const watchPeriod = timeToNadirMin != null
    ? `around ${Math.round(timeToNadirMin)} min after finishing`
    : SIMULATE_WATCH_WINDOW_GENERIC;

  let carbAdvice = null;
  if (projectedLow < low) {
    const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
    const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);
    carbAdvice = preventativeCarbAdvice(projectedLow, timeToNadirMin ?? SIMULATE_CARB_TROUGH_ETA_DEFAULT_MIN, factorResult.factor, settings);
  }

  return {
    withheldReason: null,
    workoutType, durationMin, intensity,
    currentGlucose: ctx.currentGlucose,
    iob: ctx.iob,
    source, sampleSize,
    projectedLow, projectedHigh,
    risk, watchPeriod,
    carbAdvice,
  };
}

/* ── "Unplug" pump-disconnect simulator ─────────────────────────
   Same live/anchored spirit as workoutSimulate, but for the very
   different question "what if I take the pump off for a while" — no
   basal at all rather than a normal-basal workout. Two things stack:
   the BG *rise* from the basal insulin that won't be delivered, and
   the BG *drop* from whatever activity is happening during the
   disconnect (reusing estimateExerciseDrop — swimming/walking/running
   are exactly why someone unplugs). The engine otherwise never models
   basal at all (see whatIfSimulator's own note above) — this is the
   one place it does, deliberately scoped to just this question.

   Historical grounding: detectBasalSuspendEpisodes below finds past
   stretches where the pump's own delivered-rate stream (basalDoses —
   real Tandem/Control-IQ segments, not a schedule) actually went to
   ~0 for a while. Only ones that overlap a logged workout are used as
   personal precedent here — Control-IQ can also auto-suspend basal on
   its own when it predicts a low, which would look identical in the
   raw rate data but means something completely different (BG was
   already trending down before the suspend even started); requiring
   a logged workout is what keeps this to "deliberately took it off to
   exercise" instances instead of contaminating the estimate with
   those. With >=2 comparable-duration personal instances, their
   actual outcome is used directly (in a real disconnect, the exercise
   drop already happened along with the missed basal, so the observed
   delta captures both at once, however they trade off in real life)
   instead of the physiological formula. */
const UNPLUG_RATE_NEAR_ZERO_UPH        = 0.05; // u/hr — below this counts as "suspended", not just a low temp rate
const UNPLUG_MIN_EPISODE_MIN           = 10;   // shorter blips aren't a deliberate disconnect
const UNPLUG_EPISODE_GAP_TOLERANCE_MIN = 10;   // bridges small gaps in the ~5min segment stream within one suspend run
const UNPLUG_DURATION_SIMILARITY_PCT   = 0.5;  // past episode's duration must be within +/-50% of the requested one to count as comparable
const UNPLUG_MIN_PERSONAL_EPISODES     = 2;    // same threshold as WORKOUT_MIN_SESSIONS_PERSONAL, for consistency
const UNPLUG_BASAL_RATE_LOOKBACK_HOURS = 2;    // how far back to average the "rate that would have been delivered"
const UNPLUG_EPISODE_HISTORY_LIMIT     = 20;

// Time-weighted average delivered basal rate over the trailing window —
// stands in for "the rate that would have kept being delivered" since
// Control-IQ continuously auto-adjusts it rather than running a flat
// scheduled rate, so a straight schedule lookup wouldn't reflect reality.
function resolveRecentBasalRate(basalDoses, now, lookbackHours = UNPLUG_BASAL_RATE_LOOKBACK_HOURS) {
  const nowMs = toMs(now);
  const recent = windowFilter(basalDoses, 'time', nowMs - lookbackHours * 3600000, nowMs);
  let totalUnits = 0, totalHours = 0;
  for (const d of recent) {
    const durH = (Number(d.durationMin) || 0) / 60;
    if (durH <= 0 || !Number.isFinite(Number(d.rate))) continue;
    totalUnits += Number(d.rate) * durH;
    totalHours += durH;
  }
  return totalHours > 0 ? totalUnits / totalHours : null;
}

// Finds past near-zero-rate runs in the real delivered-basal stream long
// enough to be a genuine disconnect, each cross-referenced against
// logged workouts and the surrounding glucose trace.
function detectBasalSuspendEpisodes(basalDoses, glucoseHistory, activities, now = Date.now()) {
  const nowMs = toMs(now);
  const segments = (basalDoses || [])
    .map(d => ({ ms: toMs(d.time), durationMin: Number(d.durationMin) || 0, rate: Number(d.rate) }))
    .filter(d => d.ms != null && d.ms <= nowMs && d.durationMin > 0 && Number.isFinite(d.rate))
    .sort((a, b) => a.ms - b.ms);

  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const workouts = activities?.workouts || [];

  const runs = [];
  let current = null;
  for (const seg of segments) {
    const segEndMs = seg.ms + seg.durationMin * 60000;
    if (seg.rate > UNPLUG_RATE_NEAR_ZERO_UPH) {
      if (current) { runs.push(current); current = null; }
      continue;
    }
    if (!current) {
      current = { startMs: seg.ms, endMs: segEndMs };
    } else if (seg.ms - current.endMs <= UNPLUG_EPISODE_GAP_TOLERANCE_MIN * 60000) {
      current.endMs = Math.max(current.endMs, segEndMs);
    } else {
      runs.push(current);
      current = { startMs: seg.ms, endMs: segEndMs };
    }
  }
  if (current) runs.push(current);

  return runs
    .map(run => {
      const durationMin = Math.round((run.endMs - run.startMs) / 60000);
      if (durationMin < UNPLUG_MIN_EPISODE_MIN) return null;

      const before = nearestReading(readings, run.startMs, 30);
      const after = nearestReading(readings, run.endMs, 30);
      const postWindow = readings.filter(r => r.ms >= run.endMs && r.ms <= run.endMs + WORKOUT_HISTORY_POST_WINDOW_HOURS * 3600000);
      const lowestPost = postWindow.length ? Math.min(...postWindow.map(r => r.value)) : null;

      const overlap = workouts.find(w => {
        const wStart = toMs(w.startTime);
        const wEnd = toMs(w.endTime) ?? wStart;
        return wStart != null && wStart <= run.endMs && wEnd >= run.startMs;
      });

      return {
        startMs: run.startMs, endMs: run.endMs, durationMin,
        bgBefore: before ? before.value : null,
        bgAfter: after ? after.value : null,
        bgDelta: before && after ? Math.round((after.value - before.value) * 100) / 100 : null,
        lowestPost,
        overlapsWorkout: !!overlap,
        workoutType: overlap?.workoutType || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, UNPLUG_EPISODE_HISTORY_LIMIT);
}

function estimateUnplugImpact(input, opts = {}, now = Date.now()) {
  const { durationMin = 30, workoutType = 'Unplugged', intensity = 'light' } = opts;
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], activities = {}, settings = {} } = input || {};

  const ctx = dosingContext(input, now);
  if (ctx.stale || ctx.currentGlucose == null) {
    return { withheldReason: 'stale-reading', staleMessage: ctx.staleMessage };
  }

  const basalRate = resolveRecentBasalRate(basalDoses, now);
  if (basalRate == null) {
    return { withheldReason: 'no-basal-data', staleMessage: 'No recent pump basal data synced yet — connect Nightscout in Settings to estimate this.' };
  }

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);

  const missedUnits = basalRate * (durationMin / 60);
  const riseFromMissedBasal = factorResult.factor != null ? missedUnits * factorResult.factor : null;

  const drop = estimateExerciseDrop(activities, glucoseHistory, workoutType, durationMin, intensity);
  const episodes = detectBasalSuspendEpisodes(basalDoses, glucoseHistory, activities, now);
  const comparable = episodes.filter(e =>
    e.overlapsWorkout && e.bgDelta != null &&
    e.durationMin >= durationMin * (1 - UNPLUG_DURATION_SIMILARITY_PCT) &&
    e.durationMin <= durationMin * (1 + UNPLUG_DURATION_SIMILARITY_PCT)
  );

  let projectedLow, projectedHigh, source, sampleSize;
  if (comparable.length >= UNPLUG_MIN_PERSONAL_EPISODES) {
    const deltas = comparable.map(e => e.bgDelta);
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const spread = Math.max(0.5, Math.max(...deltas) - Math.min(...deltas));
    projectedLow = Math.max(SIMULATE_PROJECTION_FLOOR_MMOL, ctx.currentGlucose + avgDelta - spread / 2);
    projectedHigh = Math.max(projectedLow, ctx.currentGlucose + avgDelta + spread / 2);
    source = 'personal';
    sampleSize = comparable.length;
  } else if (riseFromMissedBasal != null) {
    projectedLow = Math.max(SIMULATE_PROJECTION_FLOOR_MMOL, ctx.currentGlucose + riseFromMissedBasal - drop.dropHigh);
    projectedHigh = Math.max(projectedLow, ctx.currentGlucose + riseFromMissedBasal - drop.dropLow);
    source = 'physiological-estimate';
    sampleSize = 0;
  } else {
    // No reliable correction factor yet AND not enough personal precedent —
    // can still show the exercise-only drop so the tool isn't a dead end,
    // clearly labelled as not accounting for the missed basal.
    projectedLow = Math.max(SIMULATE_PROJECTION_FLOOR_MMOL, ctx.currentGlucose - drop.dropHigh);
    projectedHigh = Math.max(projectedLow, ctx.currentGlucose - drop.dropLow);
    source = 'exercise-only-no-factor';
    sampleSize = 0;
  }

  const low = Number(settings.targetLow) || HYPO_FIXED_MMOL;
  const high = Number(settings.targetHigh) || HYPER_FIXED_MMOL;
  const hypoRisk = projectedLow < low ? (projectedLow < low - 1.0 ? 'high' : 'medium') : 'low';
  const hyperRisk = projectedHigh > high ? (projectedHigh > high + 2.0 ? 'high' : 'medium') : 'low';

  let carbAdvice = null;
  if (projectedLow < low && factorResult.factor != null) {
    carbAdvice = preventativeCarbAdvice(projectedLow, drop.timeToNadirMin ?? SIMULATE_CARB_TROUGH_ETA_DEFAULT_MIN, factorResult.factor, settings);
  }

  return {
    withheldReason: null,
    durationMin, workoutType, intensity,
    currentGlucose: ctx.currentGlucose,
    iob: ctx.iob,
    basalRate: Math.round(basalRate * 1000) / 1000,
    missedUnits: Math.round(missedUnits * 100) / 100,
    riseFromMissedBasal: riseFromMissedBasal != null ? Math.round(riseFromMissedBasal * 100) / 100 : null,
    exerciseDropSource: drop.source,
    exerciseDropSampleSize: drop.sampleSize,
    projectedLow, projectedHigh,
    hypoRisk, hyperRisk,
    source, sampleSize,
    carbAdvice,
    pastEpisodes: episodes,
  };
}

/* ── Per-session workout history ──────────────────────────────
   The drill-down behind preWorkoutAdvisor's summary stats — every past
   session of the given exact workoutType, each with its own before/after
   glucose and basal delivered during the window, so a real session can
   be inspected rather than just the pooled median. */
const WORKOUT_HISTORY_LIMIT = 12; // display list only — workoutSimulate's own history use (buildWorkoutTypeProfiles) is uncapped
const WORKOUT_HISTORY_BASELINE_OFFSET_MIN = 45; // how far before start to anchor the "before" reading
const WORKOUT_HISTORY_BASELINE_TOLERANCE_MIN = 30;
const WORKOUT_HISTORY_END_TOLERANCE_MIN = 20;
const WORKOUT_HISTORY_POST_WINDOW_HOURS = 4;

function workoutHistoryDetail(input, workoutType, now = Date.now()) {
  const { glucoseHistory = [], basalDoses = [], activities = {} } = input || {};
  const nowMs = toMs(now);
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);

  const matches = (activities.workouts || [])
    .filter(w => (w.workoutType || '') === workoutType && toMs(w.startTime) != null && toMs(w.startTime) <= nowMs)
    .sort((a, b) => toMs(b.startTime) - toMs(a.startTime))
    .slice(0, WORKOUT_HISTORY_LIMIT);

  return matches.map(w => {
    const startMs = toMs(w.startTime);
    const endMs = toMs(w.endTime) ?? startMs;
    const beforeR = nearestReading(readings, startMs - WORKOUT_HISTORY_BASELINE_OFFSET_MIN * 60000, WORKOUT_HISTORY_BASELINE_TOLERANCE_MIN);
    const afterR  = nearestReading(readings, endMs, WORKOUT_HISTORY_END_TOLERANCE_MIN);
    const postWindow = readings.filter(r => r.ms >= endMs && r.ms <= endMs + WORKOUT_HISTORY_POST_WINDOW_HOURS * 3600000);
    const lowestPost4h = postWindow.length ? Math.min(...postWindow.map(r => r.value)) : null;
    const basalUnits = windowFilter(basalDoses, 'time', startMs, endMs).reduce((s, d) => s + (Number(d.units) || 0), 0);

    return {
      startTime: w.startTime,
      endTime: w.endTime,
      durationMin: Math.round((endMs - startMs) / 60000),
      bgBefore: beforeR ? beforeR.value : null,
      bgAfter: afterR ? afterR.value : null,
      lowestPost4h,
      basalUnits: basalUnits > 0 ? basalUnits : null,
    };
  });
}

/* ── "What if I…" simulator ───────────────────────────────────
   Re-runs the 2h hypo forecast against a hypothetical change — extra
   carbs eaten now, and/or a hypothetical correction dose — scoped to
   what the underlying data model can actually represent (no basal-rate
   simulation; the engine doesn't model basal in IOB at all). */
function whatIfSimulator(input, now = Date.now(), changes = {}) {
  const { extraCarbs = 0, hypotheticalCorrectionUnits = 0 } = changes;
  const nowMs = toMs(now);

  const modifiedBoluses = [...(input.boluses || [])];
  if (extraCarbs > 0) modifiedBoluses.push({ time: nowMs, units: 0, carbs: extraCarbs });

  const modifiedCorrections = [...(input.corrections || [])];
  if (hypotheticalCorrectionUnits > 0) {
    modifiedCorrections.push({ time: nowMs, units: hypotheticalCorrectionUnits, startGlucose: null, predictedGlucose: null });
  }

  const forecast = hypoForecast2h({ ...input, boluses: modifiedBoluses, corrections: modifiedCorrections }, now);
  return { changes, forecast };
}

/* ── Preventative carb advice ─────────────────────────────────
   Grams needed to lift a projected trough up to ~5.0 mmol/L, using the
   person's own carb ratio and correction factor (run in reverse — carbs
   raise glucose rather than lower it, but the same factor converts
   between insulin-units-equivalent and mmol/L either direction).
   Classified fast-rescue (trough imminent or already below target-low —
   grab something fast-acting) vs slow-buffer (a milder, further-out dip
   — a snack with some staying power covers it better). */
function preventativeCarbAdvice(projectedTrough, minutesToTrough, factor, settings) {
  const carbRatio = Number(settings?.carbRatio) || null;
  if (projectedTrough == null || !factor || factor < MIN_RELIABLE_FACTOR || !carbRatio) {
    return { gramsNeeded: null, withheldReason: !carbRatio ? 'missing-carb-ratio' : 'low-confidence-factor' };
  }

  const deficit = PREVENTATIVE_CARB_TARGET - projectedTrough;
  if (deficit <= 0) return { gramsNeeded: 0, classification: null, message: 'Projected trough is already at or above target — no preventative carbs needed.' };

  const gramsNeeded = Math.round((deficit / factor) * carbRatio);
  const low = Number(settings?.targetLow) || 4.5;
  const isUrgent = minutesToTrough == null || minutesToTrough <= FAST_RESCUE_MINUTES || projectedTrough < low;
  const classification = isUrgent ? 'fast-rescue' : 'slow-buffer';

  return {
    gramsNeeded, classification,
    message: isUrgent
      ? `~${gramsNeeded}g of fast-acting carbs (juice, glucose tabs) may help head this off.`
      : `~${gramsNeeded}g, something with a bit of staying power, may help cover the dip ahead.`,
  };
}

/* ═══════════════════════════════════════════════════════════
   STAGE 5 — Reviews
   Meal memory, meal-dose suggestion, insulin health check, sensitivity
   map. Reuses correction-resolution and exercise-proximity logic
   already validated in Stages 2-3 rather than reinventing them.
   ═══════════════════════════════════════════════════════════ */

const MEAL_MEMORY_MIN_OCCURRENCES = 2;
const MEAL_PEAK_WINDOW_HOURS      = 4;
const MEAL_LOW_RISK_WINDOW_HOURS  = 4;
const MEAL_DOSE_RECENCY_HALFLIFE_DAYS = 30;
const MEAL_DOSE_RATING_WINDOW_HOURS   = 6;
const MEAL_DOSE_MIN_SAMPLES       = 3;
const HEALTH_CHECK_WINDOW_DAYS    = 7;

// How much a past meal's weight decays as its BG trend / active-IOB
// situation diverges from right now — same exponential-similarity
// shape as carbSimWeight/timeOfDayWeight below, just on two more axes.
// A past meal eaten in a near-identical situation (falling fast with
// insulin already onboard, say) counts almost fully; one eaten in a
// very different situation still counts, just far less. Scales picked
// off the trendArrow() thresholds (app.js) and typical IOB range: ~0.08
// mmol/L/min is roughly the up/steepUp boundary, ~1u is a normal
// single-meal dose.
const SITUATION_TREND_SCALE_MMOL_PER_MIN = 0.08;
const SITUATION_IOB_SCALE_UNITS          = 1.0;
const SITUATION_MATCH_THRESHOLD          = 0.4; // combined weight above this counts as "a similar situation" for the UI note

/* ── Meal memory ──────────────────────────────────────────────
   Only meals with a real name can be "remembered" — unnamed boluses
   (e.g. from a pump with no food-name data, see nightscout-adapter.js)
   are excluded rather than lumped together as if they were the same
   recurring meal. Needs >=2 occurrences of the same name to say
   anything at all.

   Two sources feed this, merged by name: Nightscout boluses that
   happen to carry a food name (Loop/AndroidAPS-style uploaders), and
   macroMealLog — diabetes_meals, which is the ONLY source with a name
   for pumps like Tandem that don't report one at all (see
   nightscout-adapter.js). macroMealLog also carries a dose figure
   (the confirmed actual bolus once linked, else the suggestion the
   entry was recorded with), which the bolus-only path never has —
   that's what makes the per-dose rating below possible, and it's the
   same recency-weighted signal macroMealOutcomeBias already nudges
   suggestMacroMealDose with (see there), surfaced here per-instance
   so that nudge is explainable rather than a black box. */
function mealMemory(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], macroMealLog = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;

  const named = (boluses || []).filter(b => b.mealName && Number(b.carbs) > 0 && toMs(b.time) <= nowMs);

  const byName = {};
  for (const m of named) {
    const ms = toMs(m.time);
    const preR = nearestReading(readings, ms, 20);
    const window = readings.filter(r => r.ms >= ms && r.ms <= ms + MEAL_PEAK_WINDOW_HOURS * 3600000);
    if (!preR || window.length < 3) continue;

    const peakR = window.reduce((max, r) => (r.value > max.value ? r : max), window[0]);
    const afterPeak = window.filter(r => r.ms >= peakR.ms);
    const backInRange = afterPeak.find(r => r.value <= high && r.value >= low);
    const lowRiskWindow = readings.filter(r => r.ms >= ms && r.ms <= ms + MEAL_LOW_RISK_WINDOW_HOURS * 3600000);

    if (!byName[m.mealName]) byName[m.mealName] = [];
    byName[m.mealName].push({
      peak: peakR.value,
      rise: peakR.value - preR.value,
      timeToPeakMin: minutesBetween(ms, peakR.ms),
      returnToRangeMin: backInRange ? minutesBetween(peakR.ms, backInRange.ms) : null,
      wentLow: lowRiskWindow.some(r => r.value < low),
    });
  }

  const delayedRiseResult = patternDelayedRiseMeals({
    boluses: named.map(m => ({ ...m, _ms: toMs(m.time) })),
    readings,
    settings,
  });
  const delayedRiseNames = new Set((delayedRiseResult?.flagged || []).map(f => f.mealName).filter(Boolean));

  // Dose ratings from macroMealLog — independent of the bolus-name path
  // above, so a meal only ever logged via the macro flow (the normal
  // case for Tandem) still shows up. Rates each instance 'good' / 'high'
  // / 'low' against the 6h window following the meal, same threshold
  // logic macroMealOutcomeBias uses for the live nudge.
  const doseByName = {};
  const dosedMeals = (macroMealLog || [])
    .filter(m => m.mealName && toMs(m.time) <= nowMs && m.actualDose != null);
  for (const m of dosedMeals) {
    const ms = toMs(m.time);
    const window = readings.filter(r => r.ms >= ms && r.ms <= ms + MEAL_DOSE_RATING_WINDOW_HOURS * 3600000);
    if (window.length < 2) continue;

    const preR = nearestReading(readings, ms, 20);
    const minV = Math.min(...window.map(r => r.value));
    const maxV = Math.max(...window.map(r => r.value));
    let outcome = 'good';
    if (minV < low) outcome = 'low';
    else if (maxV > high) outcome = 'high';

    if (!doseByName[m.mealName]) doseByName[m.mealName] = [];
    doseByName[m.mealName].push({
      time: ms,
      dose: m.actualDose,
      carbs: Number.isFinite(Number(m.carbs)) ? Number(m.carbs) : null,
      preGlucose: preR ? preR.value : null,
      minGlucose: minV,
      maxGlucose: maxV,
      outcome,
    });
  }
  const doseStatsByName = {};
  for (const [mealName, occ] of Object.entries(doseByName)) {
    if (occ.length < MEAL_MEMORY_MIN_OCCURRENCES) continue;
    const sorted = [...occ].sort((a, b) => b.time - a.time);
    const counts = { good: 0, high: 0, low: 0 };
    occ.forEach(o => counts[o.outcome]++);
    doseStatsByName[mealName] = {
      doseN: occ.length,
      avgDoseUsed: mean(occ.map(o => o.dose)),
      doseRatingCounts: counts,
      lastDose: { units: sorted[0].dose, outcome: sorted[0].outcome },
      doseInstances: sorted,
    };
  }

  const mealNames = new Set([...Object.keys(byName), ...Object.keys(doseStatsByName)]);
  const results = [];
  for (const mealName of mealNames) {
    const occ = byName[mealName];
    const occQualifies = occ && occ.length >= MEAL_MEMORY_MIN_OCCURRENCES;
    const doseStats = doseStatsByName[mealName]; // already >= MEAL_MEMORY_MIN_OCCURRENCES if present
    if (!occQualifies && !doseStats) continue;

    results.push({
      mealName,
      n: occQualifies ? occ.length : null,
      avgPeak: occQualifies ? mean(occ.map(o => o.peak)) : null,
      avgRise: occQualifies ? mean(occ.map(o => o.rise)) : null,
      avgTimeToPeakMin: occQualifies ? mean(occ.map(o => o.timeToPeakMin)) : null,
      avgReturnToRangeMin: occQualifies ? mean(occ.filter(o => o.returnToRangeMin != null).map(o => o.returnToRangeMin)) : null,
      lowRiskPct: occQualifies ? (occ.filter(o => o.wentLow).length / occ.length) * 100 : null,
      isDelayedRise: delayedRiseNames.has(mealName),
      ...(doseStats || {}),
    });
  }

  return results.sort((a, b) => (b.n || b.doseN || 0) - (a.n || a.doseN || 0));
}

/* ── Meal-dose suggestion ────────────────────────────────────
   Weights every past carb-bearing bolus by: carb similarity to the new
   meal, recency (30-day half-life), time-of-day proximity, whether it
   shares the same exercise-context as right now, AND how closely its
   own BG trend + active IOB (at the moment it was eaten) match right
   now's — a meal eaten while falling with insulin already onboard is
   a much more relevant precedent for another falling/stacked moment
   than one eaten flat with a clear tank, even if the carb count is
   identical. Ratio outliers (an unusually high/low observed
   grams-per-unit for that one meal, via IQR) get down-weighted rather
   than excluded outright. The final suggestion is nudged a small,
   capped amount by how similar past meals actually turned out (ran
   high → nudge up; went low → nudge down). Falls back to the plain
   manual carb ratio when there isn't enough weighted history to trust
   — never fabricates a personalized number from too little data. */
function suggestMealDose(input, newCarbs, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const workouts = activities.workouts || [];
  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const curveOpts = insulinCurveOpts(settings);

  const isNearExercise = (ms) => workouts.some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });
  const nowNearExercise = isNearExercise(nowMs);
  const nowHour = hourOfDay(nowMs);
  const nowTrend = computeTrend(glucoseHistory, nowMs);
  const nowIob = activeInsulin(boluses, corrections, nowMs, curveOpts);

  const pastMeals = (boluses || [])
    .filter(b => Number(b.carbs) > 0 && Number(b.units) > 0 && toMs(b.time) < nowMs)
    .map(b => {
      const ms = toMs(b.time);
      const carbs = Number(b.carbs), units = Number(b.units);
      const ratio = carbs / units;
      const daysAgo = (nowMs - ms) / DAY_MS;
      const recencyWeight = Math.pow(0.5, daysAgo / MEAL_DOSE_RECENCY_HALFLIFE_DAYS);
      const carbSimWeight = Math.exp(-Math.abs(carbs - newCarbs) / Math.max(15, newCarbs * 0.5));
      const hourDiff = Math.min(Math.abs(hourOfDay(ms) - nowHour), 24 - Math.abs(hourOfDay(ms) - nowHour));
      const timeOfDayWeight = Math.exp(-hourDiff / 6);
      const exerciseWeight = isNearExercise(ms) === nowNearExercise ? 1 : 0.5;

      // -1ms excludes this meal's own bolus from its own "IOB already
      // onboard when I ate this" reading — same as nowIob only counting
      // doses already active before the (hypothetical) new one.
      const pastTrend = computeTrend(glucoseHistory, ms);
      const pastIob = activeInsulin(boluses, corrections, ms - 1, curveOpts);
      const trendSimWeight = Math.exp(-Math.abs(pastTrend - nowTrend) / SITUATION_TREND_SCALE_MMOL_PER_MIN);
      const iobSimWeight = Math.exp(-Math.abs(pastIob - nowIob) / SITUATION_IOB_SCALE_UNITS);
      const situationWeight = trendSimWeight * iobSimWeight;

      const window = readings.filter(r => r.ms >= ms && r.ms <= ms + 3 * 3600000);
      let outcomeBias = 0; // +1 ran high, -1 went low, 0 stayed in range
      if (window.length) {
        if (Math.max(...window.map(r => r.value)) > high) outcomeBias = 1;
        if (window.some(r => r.value < low)) outcomeBias = -1;
      }
      return {
        ms, carbs, units, ratio, outcomeBias, situationWeight,
        weight: recencyWeight * carbSimWeight * timeOfDayWeight * exerciseWeight * situationWeight,
      };
    });

  if (pastMeals.length < MEAL_DOSE_MIN_SAMPLES) return fallbackMealDose(newCarbs, settings, 'insufficient-meal-history');

  const ratios = pastMeals.map(m => m.ratio).sort((a, b) => a - b);
  const q1 = ratios[Math.floor(ratios.length * 0.25)];
  const q3 = ratios[Math.floor(ratios.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr > 0) {
    for (const m of pastMeals) {
      if (m.ratio < q1 - 1.5 * iqr || m.ratio > q3 + 1.5 * iqr) m.weight *= 0.3;
    }
  }

  const totalWeight = pastMeals.reduce((s, m) => s + m.weight, 0);
  if (totalWeight <= 0) return fallbackMealDose(newCarbs, settings, 'no-comparable-meals');

  const weightedRatio = pastMeals.reduce((s, m) => s + m.ratio * m.weight, 0) / totalWeight;
  const weightedOutcomeBias = pastMeals.reduce((s, m) => s + m.outcomeBias * m.weight, 0) / totalWeight;
  const nudgePct = clamp(weightedOutcomeBias * 0.1, -0.15, 0.15); // capped +/-15%

  const units = Math.round((newCarbs / weightedRatio) * (1 + nudgePct) * 2) / 2;

  return {
    source: 'weighted-history',
    suggestedUnits: Math.max(0, units),
    weightedRatio,
    nudgePct: nudgePct * 100,
    sampleSize: pastMeals.length,
    situationalMatches: pastMeals.filter(m => m.situationWeight >= SITUATION_MATCH_THRESHOLD).length,
    withheldReason: null,
  };
}
function fallbackMealDose(newCarbs, settings, reason) {
  const carbRatio = Number(settings.carbRatio);
  if (!carbRatio) return { source: 'none', suggestedUnits: null, withheldReason: 'missing-carb-ratio' };
  return {
    source: 'manual-carb-ratio',
    suggestedUnits: Math.round((newCarbs / carbRatio) * 2) / 2,
    withheldReason: reason,
  };
}

/* ── Split dosing (fat/protein-aware) ───────────────────────────
   High-fat meals slow gastric emptying, so a same-time bolus peaks
   before the food does: a hypo now, then a late second spike a couple
   of hours out once the fat-delayed carbs finally hit. Protein makes
   this worse — gluconeogenesis gets pushed into that same delayed
   window, and fat-induced insulin resistance means it lands harder
   than usual once it arrives. These thresholds/ratios come from a
   published split-dosing guide (a fixed population rule, same "may
   help, not a rule" framing as the rest of this file) — not personal
   data, since fat/protein aren't tracked anywhere upstream yet. */
const SPLIT_DOSE_FAT_LOW_G          = 20;  // below this: single dose, no split needed
const SPLIT_DOSE_FAT_HIGH_G         = 35;  // at/above this: the more aggressive split
const SPLIT_DOSE_HIGH_PROTEIN_G     = 25;  // this much protein alongside 35g+ fat may need extra total insulin
const SPLIT_DOSE_MODERATE_UPFRONT_PCT = 0.65; // midpoint of the guide's 60-70%
const SPLIT_DOSE_HIGH_UPFRONT_PCT     = 0.5;
const SPLIT_DOSE_PROTEIN_BUMP_PCT     = 0.1;  // capped bump to total units — added to the delayed dose only
const MACRO_HISTORY_MIN_SAMPLE        = 3;
const MACRO_FAT_SIMILARITY_TOLERANCE_G = 10; // plus 40% of the new meal's own fat grams, whichever is larger

function splitDoseGuide(fatGrams, proteinGrams, settings) {
  const fat = Number(fatGrams) || 0;
  const protein = Number(proteinGrams) || 0;
  const curve = insulinCurveOpts(settings);
  const fastActing = curve.peak <= 60; // Fiasp/Lyumjev-class peak vs Novorapid-class

  if (fat < SPLIT_DOSE_FAT_LOW_G) {
    return {
      tier: 'single', fatGrams: fat, proteinGrams: protein,
      upfrontPct: 1, delayMinutes: null, highProteinFlag: false,
      message: 'Under 20g fat — a normal single dose with your usual pre-bolus timing should be fine.',
    };
  }
  if (fat < SPLIT_DOSE_FAT_HIGH_G) {
    const delayMinutes = fastActing ? 90 : 120;
    return {
      tier: 'moderate-fat', fatGrams: fat, proteinGrams: protein,
      upfrontPct: SPLIT_DOSE_MODERATE_UPFRONT_PCT, delayMinutes, highProteinFlag: false,
      message: `20-35g fat slows digestion enough to cause a second spike — dose ${Math.round(SPLIT_DOSE_MODERATE_UPFRONT_PCT * 100)}% now, the rest ${fastActing ? '~90min' : '~2h'} later.`,
    };
  }
  const highProteinFlag = protein >= SPLIT_DOSE_HIGH_PROTEIN_G;
  const delayMinutes = fastActing ? 150 : 180;
  return {
    tier: 'high-fat', fatGrams: fat, proteinGrams: protein,
    upfrontPct: SPLIT_DOSE_HIGH_UPFRONT_PCT, delayMinutes, highProteinFlag,
    message: `35g+ fat — dose 50% now, 50% ${fastActing ? '~2.5h' : '~3h'} later.`
      + (highProteinFlag ? ' High protein too, so you may need more total insulin than usual — add that extra to the later dose, not this one.' : ''),
  };
}

// Ties the plain carb-ratio/history-weighted suggestion (suggestMealDose)
// together with the fat/protein split guide above, then personalizes the
// split itself against past macro-tagged meals of a similar fat profile
// IF there's enough of that history yet (input.macroMealLog — a local,
// client-side log, since fat/protein aren't in Nightscout treatments).
// With fewer than 3 comparable past meals this stays the guide's plain
// population default, clearly labelled as such rather than personalizing
// off too little data.
// Weighted outcome bias (recency-weighted, +1 ran high / -1 went low)
// across a set of past macro-tagged meals cross-referenced against the
// glucose trace that actually followed each one. Shared by the
// meal-name and fat-similarity personalization paths below. `situation`
// (optional) additionally down-weights past meals whose BG trend/active
// IOB at the time diverged from right now's — same rationale as
// suggestMealDose's own situational weighting above: a past instance of
// this exact meal eaten in today's kind of situation (falling with
// insulin already onboard, say) is stronger evidence than one eaten in
// a calmer moment, even though both are "this meal".
function macroMealOutcomeBias(comparable, readings, low, high, nowMs, situation = null) {
  let weightedBias = 0, totalWeight = 0, situationalMatches = 0;
  for (const m of comparable) {
    const ms = toMs(m.time);
    const daysAgo = (nowMs - ms) / DAY_MS;
    let weight = Math.pow(0.5, daysAgo / MEAL_DOSE_RECENCY_HALFLIFE_DAYS);
    if (situation) {
      const { glucoseHistory, boluses, corrections, curveOpts, nowTrend, nowIob } = situation;
      const pastTrend = computeTrend(glucoseHistory, ms);
      const pastIob = activeInsulin(boluses, corrections, ms - 1, curveOpts);
      const situationWeight =
        Math.exp(-Math.abs(pastTrend - nowTrend) / SITUATION_TREND_SCALE_MMOL_PER_MIN) *
        Math.exp(-Math.abs(pastIob - nowIob) / SITUATION_IOB_SCALE_UNITS);
      if (situationWeight >= SITUATION_MATCH_THRESHOLD) situationalMatches++;
      weight *= situationWeight;
    }
    const window = readings.filter(r => r.ms >= ms && r.ms <= ms + 6 * 3600000);
    if (!window.length) continue;
    let bias = 0;
    if (window.some(r => r.value < low)) bias = -1;
    else if (Math.max(...window.map(r => r.value)) > high) bias = 1;
    weightedBias += bias * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? { bias: weightedBias / totalWeight, situationalMatches } : null;
}

// Full bolus calculator: carbs/ICR (personalized by exact meal-name
// history once there's enough of it -- a name match is a far stronger
// signal than carb-amount similarity -- falling back to fat-similarity
// otherwise) + (current glucose - target)/factor - active IOB, floored
// at 0 since insulin can't be un-injected. A low current reading pulls
// the total down (or to zero) same as it should; a high one adds a
// correction on top. Split-dosing is applied to the combined total.
function suggestMacroMealDose(input, meal, now = Date.now()) {
  const { carbs = 0, fat = 0, protein = 0, mealName = null } = meal || {};
  const settings = input.settings || {};
  const idealTarget = Number(settings.idealTarget);
  const nowMs = toMs(now);
  const guide = splitDoseGuide(fat, protein, settings);

  const ctx = dosingContext(input, now);
  if (ctx.stale) {
    return { suggestedUnits: null, withheldReason: 'stale-reading', guide, upfrontUnits: null, delayedUnits: null, personalized: false };
  }

  // --- carb portion ---
  let carbUnits = 0;
  let carbBase = { source: 'none' };
  let personalized = false, personalizedBy = null, personalizedSampleSize = 0, nudgePct = 0;
  let situationalMatches = 0;

  if (carbs > 0) {
    carbBase = suggestMealDose(input, carbs, now);
    if (carbBase.suggestedUnits == null) {
      return { ...carbBase, guide, upfrontUnits: null, delayedUnits: null, personalized: false };
    }
    carbUnits = carbBase.suggestedUnits;
    situationalMatches += carbBase.situationalMatches || 0;

    const readings = sortedReadings(input.glucoseHistory, -Infinity, nowMs);
    const low = Number(settings.targetLow) || 4.5;
    const high = Number(settings.targetHigh) || 8.5;
    const log = (input.macroMealLog || []).filter(m => m.time != null && toMs(m.time) < nowMs);

    const byName = mealName ? log.filter(m => (m.mealName || '').trim().toLowerCase() === mealName.trim().toLowerCase()) : [];
    const useNameMatch = byName.length >= MACRO_HISTORY_MIN_SAMPLE;
    const tolerance = Math.max(MACRO_FAT_SIMILARITY_TOLERANCE_G, fat * 0.4);
    const byFat = log.filter(m => Number.isFinite(Number(m.fat)) && Math.abs(Number(m.fat) - fat) <= tolerance);
    const comparable = useNameMatch ? byName : byFat;

    if (comparable.length >= MACRO_HISTORY_MIN_SAMPLE) {
      const situation = {
        glucoseHistory: input.glucoseHistory, boluses: input.boluses, corrections: input.corrections,
        curveOpts: insulinCurveOpts(settings), nowTrend: ctx.trendPerMinute, nowIob: ctx.iob,
      };
      const result = macroMealOutcomeBias(comparable, readings, low, high, nowMs, situation);
      if (result != null) {
        nudgePct = clamp(result.bias * 0.12, -0.2, 0.2); // capped +/-20%
        personalized = true;
        personalizedBy = useNameMatch ? 'meal-name' : 'fat-similarity';
        personalizedSampleSize = comparable.length;
        situationalMatches += result.situationalMatches;
        carbUnits = Math.max(0, carbUnits * (1 + nudgePct));
      }
    }
  }

  // --- correction portion: current glucose vs target, right now ---
  const resolvedCorrections = resolveCorrections(input.corrections, input.glucoseHistory, input.boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);
  const correctionAvailable = Number.isFinite(idealTarget) && factorResult.factor != null;
  const correctionUnits = correctionAvailable ? (ctx.effectiveGlucose - idealTarget) / factorResult.factor : 0;

  let total = carbUnits + correctionUnits - ctx.iob;
  const zeroedByFloor = total < 0;
  total = Math.max(0, total);

  if (guide.highProteinFlag) total *= (1 + SPLIT_DOSE_PROTEIN_BUMP_PCT);

  const upfrontUnits = Math.round(total * guide.upfrontPct * 2) / 2;
  const delayedUnits = guide.tier === 'single' ? 0 : Math.max(0, Math.round((total - upfrontUnits) * 2) / 2);
  const low = Number(settings.targetLow) || 4.5;

  return {
    suggestedUnits: Math.round(total * 2) / 2,
    carbUnits: Math.round(carbUnits * 100) / 100,
    correctionUnits: Math.round(correctionUnits * 100) / 100,
    correctionAvailable,
    iob: ctx.iob,
    currentGlucose: ctx.currentGlucose,
    effectiveGlucose: ctx.effectiveGlucose,
    trendPerMinute: ctx.trendPerMinute,
    idealTarget: Number.isFinite(idealTarget) ? idealTarget : null,
    factor: factorResult.factor,
    factorSource: factorResult.source,
    factorSampleSize: factorResult.sampleSize,
    source: carbBase.source,
    guide, upfrontUnits, delayedUnits,
    personalized, personalizedBy, personalizedSampleSize,
    situationalMatches,
    nudgePct: nudgePct * 100,
    zeroedByFloor,
    lowGlucoseWarning: ctx.effectiveGlucose != null && ctx.effectiveGlucose < low,
    withheldReason: null,
  };
}

/* ── Insulin health check ─────────────────────────────────────
   TIR/TBR/TAR here deliberately use the FIXED clinical cut-points
   (3.9 / 10.0), not the person's own target range — this review is
   meant to read the same way a clinician's report would, which is the
   opposite intent from Stage 3's pattern analysis (personal range). */
function computeWeekStats(glucoseHistory, boluses, corrections, basalDoses, startMs, endMs) {
  const readings = sortedReadings(glucoseHistory, startMs, endMs);
  const stats = glucoseStats(readings);
  const tir = timeInRange(readings, HYPO_FIXED_MMOL, HYPER_FIXED_MMOL);
  const bolusesInWindow = windowFilter(boluses, 'time', startMs, endMs);
  const correctionsInWindow = windowFilter(corrections, 'time', startMs, endMs);
  const basalInWindow = windowFilter(basalDoses, 'time', startMs, endMs);
  const bolusUnits = bolusesInWindow.reduce((s, b) => s + (Number(b.units) || 0), 0);
  const correctionUnits = correctionsInWindow.reduce((s, c) => s + (Number(c.units) || 0), 0);
  const basalUnits = basalInWindow.reduce((s, d) => s + (Number(d.units) || 0), 0);

  // Average over how much history is actually here, not the full
  // requested window — a sync that only just started (or a window that
  // reaches back before it) would otherwise divide real insulin totals
  // by mostly-empty days and badly understate daily dose.
  const earliestOf = arr => arr.reduce((min, x) => (x._ms < min ? x._ms : min), Infinity);
  const earliestMs = Math.min(
    readings.length ? readings[0].ms : Infinity,
    earliestOf(bolusesInWindow), earliestOf(correctionsInWindow), earliestOf(basalInWindow),
  );
  const coverageStart = Number.isFinite(earliestMs) ? Math.max(earliestMs, startMs) : startMs;
  const days = Math.max(1, (endMs - coverageStart) / DAY_MS);
  const tdd = (bolusUnits + correctionUnits + basalUnits) / days;

  return {
    n: readings.length, tir, cv: stats?.cv ?? null, tdd,
    bolusPct: tdd > 0 ? (((bolusUnits + correctionUnits) / days) / tdd) * 100 : null,
    basalPct: tdd > 0 ? ((basalUnits / days) / tdd) * 100 : null,
  };
}

function insulinHealthCheck(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const thisWeekStart = nowMs - HEALTH_CHECK_WINDOW_DAYS * DAY_MS;
  const lastWeekStart = nowMs - 2 * HEALTH_CHECK_WINDOW_DAYS * DAY_MS;

  const thisWeek = computeWeekStats(glucoseHistory, boluses, corrections, basalDoses, thisWeekStart, nowMs);
  if (thisWeek.n < PATTERN_MIN_READINGS) return { sufficient: false, readingCount: thisWeek.n };

  const lastWeek = computeWeekStats(glucoseHistory, boluses, corrections, basalDoses, lastWeekStart, thisWeekStart);
  const weightKg = Number(settings.weightKg) || null;
  const heightCm = Number(settings.heightCm) || null;

  return {
    sufficient: true,
    thisWeek: {
      ...thisWeek,
      tddPerKg: weightKg ? thisWeek.tdd / weightKg : null,
      bmi: (weightKg && heightCm) ? weightKg / (heightCm / 100) ** 2 : null,
    },
    lastWeek: lastWeek.n >= PATTERN_MIN_READINGS ? lastWeek : null,
    trend: lastWeek.n >= PATTERN_MIN_READINGS ? {
      tddDelta: thisWeek.tdd - lastWeek.tdd,
      tirDelta: (thisWeek.tir?.pctInRange ?? 0) - (lastWeek.tir?.pctInRange ?? 0),
      cvDelta: (thisWeek.cv ?? 0) - (lastWeek.cv ?? 0),
    } : null,
  };
}

/* ── Sensitivity map ──────────────────────────────────────────
   Correction strength (personal factor, mmol/L per unit) cross-
   tabulated by time-of-day and post-exercise-vs-rest — every cell
   carries its own n rather than a single pooled average, since some
   combinations will genuinely have far less data than others. */
const SENSITIVITY_TOD_BUCKETS = [
  { label: 'Night (00-06)',     from: 0,  to: 6 },
  { label: 'Morning (06-12)',   from: 6,  to: 12 },
  { label: 'Afternoon (12-18)', from: 12, to: 18 },
  { label: 'Evening (18-24)',   from: 18, to: 24 },
];

function sensitivityMap(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {} } = input || {};
  const nowMs = toMs(now);
  const clean = resolveCorrections(corrections, glucoseHistory, boluses, now)
    .map(c => ({ ...c, _ms: toMs(c.time) }))
    .filter(c => c._ms != null && c._ms <= nowMs && c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit));

  const isNearExercise = (ms) => (activities.workouts || []).some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });

  const cells = [];
  for (const bucket of SENSITIVITY_TOD_BUCKETS) {
    for (const context of ['post-exercise', 'rest']) {
      const inCell = clean.filter(c => {
        const h = hourOfDay(c._ms);
        const inTod = h >= bucket.from && h < bucket.to;
        return inTod && (isNearExercise(c._ms) === (context === 'post-exercise'));
      });
      cells.push({
        timeOfDay: bucket.label,
        context,
        n: inCell.length,
        avgDropPerUnit: inCell.length ? mean(inCell.map(c => c.dropPerUnit)) : null,
      });
    }
  }
  return cells;
}

/* ── Prescribed regimen reference ─────────────────────────────
   Time-weighted average of a pump-programmed profile (segments shaped
   { time: "HH:MM", basalRate, correctionFactor, carbRatio, targetBg })
   across the same 4 time-of-day buckets sensitivityMap/basalWindowReview
   already use — purely a REFERENCE for comparison against the observed,
   data-driven numbers elsewhere in this file, never itself a suggestion.
   A window can span more than one pump segment (e.g. Night 00-06 crosses
   a 04:00 rate change), hence the weighting rather than a plain lookup.
   Only ever reads the "default" profile — a day-of-week override (e.g.
   a Thursday-only profile) is real but averaging it in would blur one
   day's very different numbers into a week-wide reference that no
   single day actually runs; simpler and more honest to keep this to the
   profile that applies most of the week and let the caller footnote the
   exception. */
function toHourDecimal(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h + (m || 0) / 60;
}
function timeWeightedAverage(segments, fromHour, toHour, field) {
  if (!segments?.length) return null;
  const sorted = [...segments].sort((a, b) => toHourDecimal(a.time) - toHourDecimal(b.time));
  let totalWeight = 0, weightedSum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const segStart = toHourDecimal(sorted[i].time);
    const segEnd = i + 1 < sorted.length ? toHourDecimal(sorted[i + 1].time) : 24;
    const overlapStart = Math.max(fromHour, segStart);
    const overlapEnd = Math.min(toHour, segEnd);
    if (overlapEnd > overlapStart && sorted[i][field] != null) {
      const weight = overlapEnd - overlapStart;
      weightedSum += Number(sorted[i][field]) * weight;
      totalWeight += weight;
    }
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}
function prescribedRegimenTable(pumpProfile) {
  const segments = pumpProfile?.default;
  if (!segments?.length) return null;
  return SENSITIVITY_TOD_BUCKETS.map(bucket => ({
    timeOfDay: bucket.label,
    basalRate: timeWeightedAverage(segments, bucket.from, bucket.to, 'basalRate'),
    correctionFactor: timeWeightedAverage(segments, bucket.from, bucket.to, 'correctionFactor'),
    carbRatio: timeWeightedAverage(segments, bucket.from, bucket.to, 'carbRatio'),
  }));
}

/* ═══════════════════════════════════════════════════════════
   STAGE 6 — Regimen review (basal-by-window / carb-ratio)
   Retrospective, standing-setting suggestions — a different animal
   from the tactical one-off correction/meal doses above. A bad basal
   or carb-ratio suggestion affects every hour or every meal until
   it's changed back, so this uses a tighter cap, a higher
   sample-size floor, and a same-direction-consistency check on top
   of average magnitude (a strong average pulled by one outlier is
   exactly the kind of fake precision this file avoids everywhere
   else). Always framed as worth reviewing with your diabetes team —
   this computes a number, but it is NOT a standing instruction.
   ═══════════════════════════════════════════════════════════ */
const REGIMEN_LOOKBACK_DAYS            = 7;
const REGIMEN_MIN_CLEAN_SAMPLES        = 4;   // per window/ratio check — higher bar than tactical doses (3)
const REGIMEN_CLEAN_IOB_MAX            = 0.3; // units — below this counts as "no meaningful insulin activity"
const REGIMEN_MIN_COVERAGE_PCT         = 0.8; // fraction of a window's readings that must be present to trust it
const REGIMEN_MAX_PCT_CHANGE           = 15;  // hard cap on any suggested basal-rate or carb-ratio change
const REGIMEN_MIN_DIRECTION_CONSISTENCY = 0.7; // >=70% of clean instances must agree on direction
const REGIMEN_MIN_DRIFT_MMOL           = 1.0; // average drift below this isn't worth flagging at all
const REGIMEN_MIN_OUTCOME_BIAS         = 0.3; // average meal outcome bias below this isn't worth flagging

// Per time-of-day bucket: find "clean" windows in the trailing week
// where no bolus/correction insulin and no carbs were active anywhere
// across the whole window, then see whether glucose drifted anyway —
// drift with nothing else going on is the classic basal-too-low
// (drifted up) / basal-too-high (drifted down) signal.
function basalWindowReview(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const readings = sortedReadings(glucoseHistory, windowStart, nowMs);
  const curveOpts = insulinCurveOpts(settings);

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);

  return SENSITIVITY_TOD_BUCKETS.map(bucket => {
    const windowHours = bucket.to - bucket.from;
    const instances = [];

    for (let dayStart = windowStart; dayStart < nowMs; dayStart += DAY_MS) {
      const wStart = dayStart + bucket.from * 3600000;
      const wEnd = dayStart + bucket.to * 3600000;
      if (wEnd > nowMs) continue;

      const windowReadings = readings.filter(r => r.ms >= wStart && r.ms <= wEnd);
      const expectedCount = (windowHours * 60) / 5; // ~5min CGM cadence
      if (windowReadings.length < expectedCount * REGIMEN_MIN_COVERAGE_PCT) continue;

      let clean = true;
      for (let t = wStart; t <= wEnd; t += 30 * 60000) {
        if (activeInsulin(boluses, corrections, t, curveOpts) > REGIMEN_CLEAN_IOB_MAX || carbsOnBoard(boluses, t) > 0) {
          clean = false;
          break;
        }
      }
      if (!clean) continue;

      const quarter = Math.max(1, Math.round(windowReadings.length * 0.25));
      const drift = mean(windowReadings.slice(-quarter).map(r => r.value)) - mean(windowReadings.slice(0, quarter).map(r => r.value));
      const basalUnitsInWindow = windowFilter(basalDoses, 'time', wStart, wEnd).reduce((s, dd) => s + (Number(dd.units) || 0), 0);
      instances.push({ drift, basalRate: basalUnitsInWindow / windowHours });
    }

    if (instances.length < REGIMEN_MIN_CLEAN_SAMPLES) {
      return { timeOfDay: bucket.label, n: instances.length, withheldReason: 'insufficient-clean-windows' };
    }

    const avgDrift = mean(instances.map(i => i.drift));
    const avgBasalRate = mean(instances.map(i => i.basalRate));
    const upCount = instances.filter(i => i.drift > 0.3).length;
    const downCount = instances.filter(i => i.drift < -0.3).length;
    const consistency = Math.max(upCount, downCount) / instances.length;

    if (Math.abs(avgDrift) < REGIMEN_MIN_DRIFT_MMOL || consistency < REGIMEN_MIN_DIRECTION_CONSISTENCY) {
      return { timeOfDay: bucket.label, n: instances.length, avgDrift, withheldReason: 'no-consistent-signal' };
    }
    if (factorResult.factor == null || factorResult.factor < MIN_RELIABLE_FACTOR) {
      return { timeOfDay: bucket.label, n: instances.length, avgDrift, withheldReason: 'low-confidence-factor' };
    }
    if (!avgBasalRate) {
      return { timeOfDay: bucket.label, n: instances.length, avgDrift, withheldReason: 'no-basal-data' };
    }

    // Extra units/hour that would have held it flat, as a %-of-current-rate change.
    const extraUnitsPerHour = (avgDrift / factorResult.factor) / windowHours;
    const rawPctChange = (extraUnitsPerHour / avgBasalRate) * 100;
    const suggestedPctChange = clamp(rawPctChange, -REGIMEN_MAX_PCT_CHANGE, REGIMEN_MAX_PCT_CHANGE);

    return {
      timeOfDay: bucket.label, n: instances.length, avgDrift, avgBasalRate,
      suggestedPctChange, direction: suggestedPctChange > 0 ? 'increase' : 'decrease',
      cappedAtLimit: Math.abs(rawPctChange) > REGIMEN_MAX_PCT_CHANGE,
      withheldReason: null,
    };
  });
}

// Whole-week carb-ratio check: did meals dosed with the current ratio
// consistently run high (ratio too loose) or low (too tight)? Excludes
// meals near exercise, same as the meal-dose/pattern checks elsewhere.
function carbRatioReview(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const carbRatio = Number(settings.carbRatio);

  const workouts = activities.workouts || [];
  const isNearExercise = ms => workouts.some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });

  const meals = (boluses || [])
    .filter(b => Number(b.carbs) > 0 && Number(b.units) > 0)
    .map(b => ({ ...b, _ms: toMs(b.time) }))
    .filter(b => b._ms != null && b._ms >= windowStart && b._ms <= nowMs && !isNearExercise(b._ms));

  if (!carbRatio) return { n: meals.length, withheldReason: 'missing-carb-ratio' };

  const outcomes = meals.map(m => {
    const window = readings.filter(r => r.ms >= m._ms && r.ms <= m._ms + 4 * 3600000);
    if (!window.length) return null;
    if (window.some(r => r.value < low)) return -1;
    if (Math.max(...window.map(r => r.value)) > high) return 1;
    return 0;
  }).filter(b => b != null);

  if (outcomes.length < REGIMEN_MIN_CLEAN_SAMPLES) {
    return { n: outcomes.length, withheldReason: 'insufficient-meals' };
  }

  const highCount = outcomes.filter(b => b === 1).length;
  const lowCount = outcomes.filter(b => b === -1).length;
  const consistency = Math.max(highCount, lowCount) / outcomes.length;
  const avgBias = mean(outcomes);

  if (consistency < REGIMEN_MIN_DIRECTION_CONSISTENCY || Math.abs(avgBias) < REGIMEN_MIN_OUTCOME_BIAS) {
    return { n: outcomes.length, currentRatio: carbRatio, withheldReason: 'no-consistent-signal' };
  }

  // Ran high consistently -> ratio too loose -> tighten (decrease grams/unit).
  // Ran low consistently -> ratio too tight -> loosen (increase grams/unit).
  const rawPctChange = clamp(-avgBias * 20, -100, 100);
  const suggestedPctChange = clamp(rawPctChange, -REGIMEN_MAX_PCT_CHANGE, REGIMEN_MAX_PCT_CHANGE);
  const suggestedRatio = Math.round(carbRatio * (1 + suggestedPctChange / 100) * 2) / 2;

  return {
    n: outcomes.length, currentRatio: carbRatio, suggestedRatio,
    suggestedPctChange, direction: suggestedPctChange < 0 ? 'tighten' : 'loosen',
    cappedAtLimit: Math.abs(rawPctChange) > REGIMEN_MAX_PCT_CHANGE,
    withheldReason: null,
  };
}

function regimenReview(input, now = Date.now()) {
  return {
    basalByWindow: basalWindowReview(input, now),
    carbRatio: carbRatioReview(input, now),
  };
}

/* ═══════════════════════════════════════════════════════════
   STAGE 7 — Forecast accuracy
   Retrospective grading of hypoForecast2h itself: replay it at past
   points where the actual 2h-later reading is now known, and see how
   the forecast held up. No stored prediction log needed — hypoForecast2h
   is a pure function of "data available as of `t`", so replaying it at
   a past `t` naturally only sees what was actually known then (the same
   <= nowMs filtering every Stage 1/2 function already does).
   ═══════════════════════════════════════════════════════════ */
const FORECAST_ACCURACY_LOOKBACK_DAYS = 14;
const FORECAST_ACCURACY_STEP_MINUTES  = 60;  // one evaluation per hour
const FORECAST_ACCURACY_MIN_SCORED    = 10;
const FORECAST_ACCURACY_MATCH_TOLERANCE_MIN = 20; // how close an actual reading must be to t+120min

function forecastAccuracy(input, now = Date.now()) {
  const { glucoseHistory = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - FORECAST_ACCURACY_LOOKBACK_DAYS * DAY_MS;
  // Evaluation has to stop far enough back that its own +2h "actual" reading
  // has already happened — otherwise the most recent hours would silently
  // score as "no actual to compare to" rather than genuinely unscoreable.
  const evalEnd = nowMs - HYPO_FORECAST_HORIZON_MIN * 60000;

  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const low = Number(settings.targetLow) || 4.5;

  const scored = [];
  for (let t = windowStart; t <= evalEnd; t += FORECAST_ACCURACY_STEP_MINUTES * 60000) {
    const forecast = hypoForecast2h(input, t);
    if (forecast.withheldReason || forecast.forecastGlucose == null) continue;
    const actual = nearestReading(readings, t + HYPO_FORECAST_HORIZON_MIN * 60000, FORECAST_ACCURACY_MATCH_TOLERANCE_MIN);
    if (!actual) continue;
    scored.push({
      t,
      predicted: forecast.forecastGlucose,
      actual: actual.value,
      error: forecast.forecastGlucose - actual.value,
      actualWentLow: actual.value < low,
      predictedWarning: forecast.tier === 'high' || forecast.tier === 'moderate',
    });
  }

  if (scored.length < FORECAST_ACCURACY_MIN_SCORED) {
    return { sufficient: false, scored: scored.length, minNeeded: FORECAST_ACCURACY_MIN_SCORED };
  }

  const errors = scored.map(s => s.error);
  const bias = mean(errors);       // signed — negative means the forecast runs low vs reality
  const mae = mean(errors.map(e => Math.abs(e)));
  const within1 = (scored.filter(s => Math.abs(s.error) <= 1).length / scored.length) * 100;
  const within2 = (scored.filter(s => Math.abs(s.error) <= 2).length / scored.length) * 100;

  // Precision/recall on the forecast's own "moderate"/"high" tier as a
  // binary low-warning: did a warning actually precede a low, and did
  // every real low get a warning first.
  const truePositives  = scored.filter(s => s.predictedWarning && s.actualWentLow).length;
  const falsePositives = scored.filter(s => s.predictedWarning && !s.actualWentLow).length;
  const falseNegatives = scored.filter(s => !s.predictedWarning && s.actualWentLow).length;
  const precision = (truePositives + falsePositives) ? (truePositives / (truePositives + falsePositives)) * 100 : null;
  const recall    = (truePositives + falseNegatives) ? (truePositives / (truePositives + falseNegatives)) * 100 : null;

  return {
    sufficient: true,
    scored: scored.length,
    bias, mae, within1, within2, precision, recall,
    warnings: scored.filter(s => s.predictedWarning).length,
    lows: scored.filter(s => s.actualWentLow).length,
  };
}

const DiabetesEngine = {
  // constants
  IOB_PEAK_MINUTES,
  IOB_DURATION_MINUTES,
  COB_DURATION_MINUTES,
  STALE_READING_MINUTES,
  insulinCurveOpts,
  MIN_RELIABLE_FACTOR,
  MAX_SUGGESTED_UNITS,
  PATTERN_LOOKBACK_DAYS,
  PATTERN_MIN_READINGS,
  CV_TARGET_MAX_PCT,
  HYPO_FIXED_MMOL,
  HYPER_FIXED_MMOL,
  // Stage 1 API
  iobFraction,
  cobFraction,
  activeInsulin,
  carbsOnBoard,
  mergeMealCarbsIntoBoluses,
  insulinActionWithin,
  carbAbsorptionWithin,
  computeTrend,
  projectedGlucose,
  dosingContext,
  // Stage 2 API
  resolveCorrection,
  resolveCorrections,
  personalCorrectionFactor,
  resolveCorrectionFactor,
  detectStackingCaution,
  suggestCorrectionDose,
  evaluateCorrection,
  // Stage 3 API
  glucoseStats,
  timeInRange,
  analyzePatterns,
  // Stage 4 API
  buildWorkoutTypeProfiles,
  workoutLiveAlert,
  hypoForecast2h,
  projectedGlucoseCurve,
  preWorkoutAdvisor,
  classifyIntensity,
  workoutSimulate,
  estimateExerciseDrop,
  workoutHistoryDetail,
  whatIfSimulator,
  preventativeCarbAdvice,
  resolveRecentBasalRate,
  detectBasalSuspendEpisodes,
  estimateUnplugImpact,
  // Stage 5 API
  mealMemory,
  suggestMealDose,
  insulinHealthCheck,
  sensitivityMap,
  prescribedRegimenTable,
  splitDoseGuide,
  suggestMacroMealDose,
  SPLIT_DOSE_FAT_LOW_G,
  SPLIT_DOSE_FAT_HIGH_G,
  SPLIT_DOSE_HIGH_PROTEIN_G,
  MACRO_HISTORY_MIN_SAMPLE,
  // Stage 6 API
  basalWindowReview,
  carbRatioReview,
  regimenReview,
  REGIMEN_MAX_PCT_CHANGE,
  // Stage 7 API
  forecastAccuracy,
};

// Dual environment: CommonJS (Node/Netlify functions) or a plain <script>
// tag in the browser, where `module` doesn't exist.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiabetesEngine;
} else if (typeof window !== 'undefined') {
  window.DiabetesEngine = DiabetesEngine;
}

})();
