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
   COB — piecewise-linear ("trapezoid") carb absorption over 180 minutes
   Real food doesn't start absorbing at full rate the instant it's eaten
   and then absorb at a constant rate the whole way through (the old flat
   linear model's implicit assumption) — digestion ramps up, holds near
   its peak rate for a while, then tails off. Ported from LoopKit's
   PiecewiseLinearAbsorption: absorption RATE rises linearly from 0 to a
   peak over the first percentEndOfRise of the duration, holds at that
   peak until percentStartOfFall, then decays linearly to 0 by the end.
   `scale` is the peak rate needed so the whole rate curve integrates to
   exactly 100% absorbed by t=duration, regardless of the two percentages
   chosen (same derivation LoopKit uses).
   ───────────────────────────────────────────────────────── */
const CARB_PCT_END_OF_RISE   = 0.15; // rate ramps 0 -> peak over the first 15% of absorption time
const CARB_PCT_START_OF_FALL = 0.5;  // holds at peak from 15% to 50%, then decays to 0 by 100%
const CARB_ABSORPTION_SCALE  = 2 / (1 + CARB_PCT_START_OF_FALL - CARB_PCT_END_OF_RISE);

// Cumulative fraction of total carbs absorbed by percentTime (0-1 of the
// way through the absorption duration) — the integral of the trapezoid
// rate curve described above, in closed form per segment.
function carbPercentAbsorbedAtPercentTime(percentTime) {
  const r1 = CARB_PCT_END_OF_RISE, r2 = CARB_PCT_START_OF_FALL, scale = CARB_ABSORPTION_SCALE;
  if (percentTime <= 0) return 0;
  if (percentTime < r1) return 0.5 * scale * percentTime * percentTime / r1;
  if (percentTime < r2) return scale * (percentTime - 0.5 * r1);
  if (percentTime < 1) {
    return scale * (r2 - 0.5 * r1 + (percentTime - r2) * (1 - 0.5 * (percentTime - r2) / (1 - r2)));
  }
  return 1;
}

// Fraction of a meal's carbs still ON BOARD (unabsorbed) `t` minutes
// after it was eaten. 1 at t<=0, 0 at t>=duration, trapezoid-shaped in
// between (see carbPercentAbsorbedAtPercentTime above).
function cobFraction(t, duration = COB_DURATION_MINUTES) {
  if (t <= 0) return 1;
  if (t >= duration) return 0;
  return 1 - carbPercentAbsorbedAtPercentTime(t / duration);
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
      if (meal.mealName) match.mealName = meal.mealName;
    } else {
      list.push({ time: eatenAt, units: 0, carbs, mealName: meal.mealName || null });
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

// Same idea as insulinActionWithin/carbAbsorptionWithin above, but
// anchored to two absolute timestamps instead of "now, now+H" — needed
// for retrospective correction, which looks BACKWARD at how much
// insulin/carb effect the model says already happened between a past
// moment and now. A dose given partway through that window (after
// startMs but before endMs) still contributes its effect from its own
// dose time onward — clamping tStart up to the dose's own time (never
// negative) handles that correctly, same as a dose given before
// startMs correctly gets tStart = its age at startMs.
function insulinEffectBetween(boluses, corrections, startMs, endMs, opts = {}) {
  const { peak = IOB_PEAK_MINUTES, duration = IOB_DURATION_MINUTES } = opts;
  let total = 0;
  for (const dose of [...(boluses || []), ...(corrections || [])]) {
    const units = Number(dose.units) || 0;
    if (units <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > endMs) continue;
    const tStart = minutesBetween(doseMs, Math.max(doseMs, startMs));
    const tEnd = minutesBetween(doseMs, endMs);
    const remainingAtStart = iobFraction(tStart, peak, duration);
    const remainingAtEnd = iobFraction(tEnd, peak, duration);
    total += units * Math.max(0, remainingAtStart - remainingAtEnd);
  }
  return total; // units of insulin action exerted between startMs and endMs
}

function carbEffectBetween(boluses, startMs, endMs, opts = {}) {
  const { duration = COB_DURATION_MINUTES } = opts;
  let total = 0;
  for (const dose of boluses || []) {
    const carbs = Number(dose.carbs) || 0;
    if (carbs <= 0) continue;
    const doseMs = toMs(dose.time);
    if (doseMs == null || doseMs > endMs) continue;
    const tStart = minutesBetween(doseMs, Math.max(doseMs, startMs));
    const tEnd = minutesBetween(doseMs, endMs);
    const remainingAtStart = cobFraction(tStart, duration);
    const remainingAtEnd = cobFraction(tEnd, duration);
    total += carbs * Math.max(0, remainingAtStart - remainingAtEnd);
  }
  return total; // grams absorbed between startMs and endMs
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
// Above this, a real ISF is clinically implausible for anyone — far more
// likely a small correction (e.g. 0.1-0.2u) got resolved against a
// glucose drop actually caused by something else nearby (exercise, an
// overlapping larger dose, food) than a genuine dose-response reading.
// Division by a tiny unit count amplifies that noise hugely, which is
// exactly the failure mode this guards against.
const MAX_RELIABLE_FACTOR    = 15;  // mmol/L per unit — above this, withhold
const MAX_SUGGESTED_UNITS    = 10;  // hard cap regardless of the math
const STACKING_MIN_AGE       = 15;  // minutes
const STACKING_MAX_AGE       = 110; // minutes
const STACKING_MIN_IOB       = 0.5; // units

// Modern pumps (e.g. Tandem t:slim X2) can deliver boluses in 0.01u
// micro-increments — every dose suggestion below rounds to that, not the
// old 0.5u snap, which was throwing away real precision someone on a
// microdosing-capable pump can actually act on.
const DOSE_ROUND_UNITS = 0.01;
const roundDose = u => Math.round(u / DOSE_ROUND_UNITS) * DOSE_ROUND_UNITS;

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
// carb-free) corrections. "Clean" excludes anything still waiting/gaveUp,
// flagged with carbInterference, or landing outside a clinically
// plausible per-correction range (MIN/MAX_RELIABLE_FACTOR) — a single
// implausible sample (typically a tiny-unit correction whose glucose
// drop was actually caused by something else) would otherwise skew the
// whole rolling average even though the other 9 samples are good. Needs
// >=3 clean samples to be trusted.
function personalCorrectionFactor(resolvedCorrections, opts = {}) {
  const { windowSize = ROLLING_FACTOR_WINDOW, minSample = MIN_CLEAN_SAMPLE } = opts;

  const clean = (resolvedCorrections || [])
    .filter(c => c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit)
      && c.dropPerUnit >= MIN_RELIABLE_FACTOR && c.dropPerUnit <= MAX_RELIABLE_FACTOR)
    .sort((a, b) => toMs(a.time) - toMs(b.time));

  const recent = clean.slice(-windowSize);

  if (recent.length < minSample) {
    return { factor: null, sampleSize: recent.length, cleanSampleSize: clean.length, sufficient: false };
  }

  const factor = recent.reduce((sum, c) => sum + c.dropPerUnit, 0) / recent.length;
  return { factor, sampleSize: recent.length, cleanSampleSize: clean.length, sufficient: true };
}

// The single point every caller (correction-dose suggestion, the 2h
// forecasts, the chart's projected curve, missed-basal impact, the meal
// calculator) gets its correction factor from. With a fresh learned model
// (applyModel, Stage 8) it's the model's ISF for this time of day, with
// boost/modifiers applied and held inside ±30% of the pump value; without
// one it's the pump setting. The old rolling average of past corrections
// (personalCorrectionFactor) no longer feeds doses — it stays exported for
// the Patterns display only. Bounded to a clinically plausible range
// (MIN/MAX_RELIABLE_FACTOR) either way; never fabricates a number.
function resolveCorrectionFactor(resolvedCorrections, settings, opts = {}) {
  const { model = null, atMs = Date.now() } = opts;
  const inBounds = f => Number.isFinite(f) && f >= MIN_RELIABLE_FACTOR && f <= MAX_RELIABLE_FACTOR;
  const applied = model ? applyModel(model, atMs, opts) : null;
  if (applied && inBounds(applied.isf)) {
    return {
      factor: applied.isf, source: doseSource(applied.isfSource), basis: applied.isfSource,
      sampleSize: applied.sampleSize, multiplier: applied.multiplier, adjustments: applied.adjustments,
      rateLimited: applied.rateLimited, outsideBand: applied.outsideBand, reasons: applied.isfReasons,
    };
  }
  const pumpFactor = Number(settings?.correctionFactor);
  if (inBounds(pumpFactor)) {
    return { factor: pumpFactor, source: 'pump-setting', sampleSize: 0, reasons: [`sensitivity ${fmt1(pumpFactor)} from your pump setting`] };
  }
  return { factor: null, source: null, sampleSize: 0, reasons: ['no correction factor set'] };
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

// How much weight the correction-dose suggestion gives the retrospective
// discrepancy, vs. the full strength it's used at in the forecast/chart.
// Those two are advisory displays; this number is the actual insulin
// units suggested, so it deliberately trusts a brand-new fast-reacting
// signal less for that — same asymmetric-caution posture as
// projectedGlucose's half-credit for a rising trend elsewhere in this file.
const CORRECTION_RC_WEIGHT = 0.5;

// Suggest dose = (effective − idealTarget)/factor − IOB, rounded to 0.5u.
// Guardrails withhold the number entirely (suggestedUnits stays null)
// rather than show something misleading — a low-confidence factor, a
// stale reading, or a still-cresting recent dose are all reasons to wait
// and look again rather than trust the math. retrospectiveDiscrepancy
// (from retrospectiveCorrection, see there) is optional and additive —
// null/omitted behaves exactly as before this existed.
function suggestCorrectionDose(ctx, factorResult, boluses, corrections, now = Date.now(), retrospectiveDiscrepancy = null, input = null) {
  const settings = ctx.settings || {};
  const idealTarget = Number(settings.idealTarget);
  const retrospectiveEffect = retrospectiveDiscrepancy != null ? retrospectiveDiscrepancy * CORRECTION_RC_WEIGHT : 0;
  const adjustedEffectiveGlucose = ctx.effectiveGlucose != null ? ctx.effectiveGlucose + retrospectiveEffect : null;

  // ctx.cob (grams still unabsorbed — see dosingContext/carbsOnBoard) was
  // computed but never used here: a reading taken while a meal or hypo
  // treatment is still digesting isn't the number glucose will settle at,
  // it's a snapshot mid-rise. Converted to an expected further mmol/L
  // rise so a correction given right now is sized for where glucose is
  // actually headed over the rest of the meal's absorption, not just
  // where it happens to be this instant.
  //
  // Priced the same way the Meal Bolus Calculator prices a fresh meal —
  // suggestMealDose: the learned model's carb ratio for this time of day
  // when a fresh model is loaded, else the pump-programmed carb ratio — so
  // the two tools never disagree about the same digesting meal.
  const carbRatio = Number(settings.carbRatio) || null;
  const cobDose = (input && ctx.cob > 0) ? suggestMealDose(input, ctx.cob, now) : null;
  const cobUnits = cobDose?.suggestedUnits != null
    ? cobDose.suggestedUnits
    : (carbRatio && ctx.cob > 0 ? ctx.cob / carbRatio : 0);
  const cobRiseMmol = (cobUnits > 0 && factorResult.factor != null) ? cobUnits * factorResult.factor : 0;

  const base = {
    factor: factorResult.factor,
    factorSampleSize: factorResult.sampleSize,
    factorSource: factorResult.source ?? null,
    effectiveGlucose: ctx.effectiveGlucose,
    retrospectiveEffect,
    adjustedEffectiveGlucose,
    cob: ctx.cob,
    cobRiseMmol,
    cobPersonalized: cobDose?.source === 'learned',
    cobPersonalizedSampleSize: cobDose?.source === 'learned' ? cobDose.sampleSize : 0,
    idealTarget,
    iob: ctx.iob,
    suggestedUnits: null,
    rawSuggestion: null,
    withheldReason: null,
    cappedAt10: false,
    stackingCaution: false,
    stackingDoses: [],
    reasons: [...(factorResult.reasons || [])],
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

  const raw = (adjustedEffectiveGlucose + cobRiseMmol - idealTarget) / factorResult.factor - ctx.iob;
  const clamped = Math.max(0, raw); // insulin can't be un-injected — never suggest negative
  const capped = Math.min(MAX_SUGGESTED_UNITS, clamped);
  const rounded = roundDose(capped);

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
  const factor = resolveCorrectionFactor(resolvedCorrections, settings, modelOpts(input, now));
  const context = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  const rc = retrospectiveCorrection(input, now);
  const suggestion = suggestCorrectionDose(context, factor, boluses, corrections, now, rc.discrepancy, input);
  return { context, resolvedCorrections, factor, retrospective: rc, suggestion };
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

// r.ms/b._ms/etc are true epoch instants (see toMs() in nightscout-adapter.js),
// so getUTCHours() here would read the wrong "hour of day" for roughly seven
// months a year — Europe/London runs an hour ahead of UTC during BST, so a
// dose/reading/workout logged at 8pm local was landing in every time-of-day
// bucket below (hourly patterns, 4h correction buckets, meal-time buckets,
// the >=17:00 "evening workout" check, similar-hour hypo lookback) as if it
// happened at 7pm. Explicit Europe/London formatting is correct regardless
// of the runtime's own timezone (browser device or Deno server) and matches
// londonNow()/londonHourMinute() elsewhere in the app.
function londonHM(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return { hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10) };
}
function hourOfDay(ms) { return londonHM(ms).hour; }
function minutesSinceMidnight(ms) {
  const { hour, minute } = londonHM(ms);
  return hour * 60 + minute;
}

function insight(id, category, title, summary, n, extra = {}) {
  return { id, category, title, summary, n, ...extra };
}

// ── 1. Correction-factor accuracy ───────────────────────────
function patternCorrectionAccuracy(d) {
  // predictedGlucose is only ever a real number when something upstream
  // actually recorded a prediction — nightscout-adapter.js sets it to
  // `null` for every correction since nothing computes one today.
  // Number(null) coerces to 0 (not NaN), which used to slip straight
  // past Number.isFinite() below and get compared against actualGlucose
  // as if "0" were a real predicted value — reporting the raw glucose
  // reading itself as a bogus "prediction error" and firing needs-attention
  // on essentially every check. Checking c.predictedGlucose directly
  // (no Number() coercion) correctly excludes the null case.
  const withPrediction = d.resolvedInWindow.filter(c =>
    c.resolved && Number.isFinite(c.predictedGlucose) && Number.isFinite(c.actualGlucose));
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
    ? `Try dosing about ${Math.abs(pctDiff).toFixed(0)}% less within 8h of exercise — a correction factor closer to ${postExAvg.toFixed(1)} mmol/L/u (vs your usual ~${restAvg.toFixed(1)}) matches what's actually been working.`
    : `You may need about ${Math.abs(pctDiff).toFixed(0)}% more insulin than usual soon after exercise — closer to ${postExAvg.toFixed(1)} mmol/L/u (vs your usual ~${restAvg.toFixed(1)}) to bring glucose down as expected.`;
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
    extra.tryText = `Consider a small carb top-up in the hours after this type of workout — glucose has been dropping about ${Math.abs(afterAvg).toFixed(1)} mmol/L on average in the 4h afterward.`;
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
      rises.length, { avgRise, positiveDays, tryText: `Ask your care team about a small pre-emptive dose or basal adjustment timed before the rise — it's been adding about ${avgRise.toFixed(1)} mmol/L on ${positiveDays}/${rises.length} mornings checked.` });
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
    return { carbs: Number(m.carbs), units: Number(m.units) || 0, rise: peak - preR.value };
  }).filter(Boolean);
  if (withOutcome.length < 9) return null;

  const sorted = [...withOutcome].sort((a, b) => a.carbs - b.carbs);
  const third = Math.floor(sorted.length / 3);
  const tertiles = {
    small:  sorted.slice(0, third),
    medium: sorted.slice(third, third * 2),
    large:  sorted.slice(third * 2),
  };
  const stats = Object.fromEntries(Object.entries(tertiles).map(([k, v]) => {
    // Observed carb-ratio (g per unit) for meals THIS size actually got —
    // purely descriptive of what already happened, not a computed
    // recommendation, so it's safe to surface directly (see the "Try"
    // text below, which only ever points at ratios already observed in
    // the user's own data rather than deriving a new number).
    const withDose = v.filter(x => x.units > 0);
    const avgRatio = withDose.length ? mean(withDose.map(x => x.carbs / x.units)) : null;
    return [k, { n: v.length, avgCarbs: mean(v.map(x => x.carbs)), avgRise: mean(v.map(x => x.rise)), avgRatio }];
  }));

  const largeVsSmall = stats.large.avgRise - stats.small.avgRise;
  const category = largeVsSmall > 3 ? 'needs-attention' : 'worth-knowing';
  const extra = { stats, largeVsSmall };
  if (largeVsSmall > 1.5) {
    extra.tryText = (stats.large.avgRatio != null && stats.small.avgRatio != null)
      ? `Your larger meals are getting about 1u per ${stats.large.avgRatio.toFixed(0)}g — similar to smaller meals' 1u per ${stats.small.avgRatio.toFixed(0)}g — but rising ${largeVsSmall.toFixed(1)} mmol/L more. Consider a stronger ratio (or a small pre-bolus) just for meals this size.`
      : 'Consider a slightly stronger dose (or a small pre-bolus) for your larger meals.';
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
    clean.length, { events, tryText: `Check IOB before correcting again — waiting at least ${(STACKING_MAX_AGE / 60).toFixed(1)}h since your last dose (the same threshold this check itself uses to flag stacking) would avoid this.` });
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
    if (avgTimeToSafety > 45) tryBits.push('treating lows with faster-acting carbs (glucose tablets or juice) — the standard ~15g-then-recheck-in-15 approach tends to work faster than large or slow-digesting treatments');
    if (overshootPct > 40) tryBits.push('sticking closer to that same ~15g rather than over-treating, to avoid rebounding high afterwards');
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
  // Same plausibility bounds personalCorrectionFactor uses (see its own
  // comment) — without them, a tiny-unit correction whose glucose drop
  // was actually caused by something else nearby produces a wildly
  // inflated dropPerUnit that skews exercise-sensitivity/drift averages
  // into clinically implausible territory (e.g. 40+ mmol/L/u).
  const cleanInWindow = resolvedInWindow.filter(c => c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit)
    && c.dropPerUnit >= MIN_RELIABLE_FACTOR && c.dropPerUnit <= MAX_RELIABLE_FACTOR);
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
// A learned correction factor is fit against small correction doses
// (typically well under a unit) — extrapolating it linearly across a
// much larger carb-equivalent load (a big meal's worth of grams, divided
// through the carb ratio) can produce a projected glucose the model has
// no real basis for, e.g. 30-40+ mmol/L, a reading no one's ever
// actually had. Clamping the forecast to this ceiling keeps a single
// oversized meal from turning "may help / worth a glance" into a number
// that looks like a hard prediction and isn't one — real severe DKA-range
// glucose is already an emergency the person knows about directly from
// their own CGM reading, not something this forecast needs to chase.
const FORECAST_GLUCOSE_MAX_MMOL   = 25;
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

/* ── Retrospective correction ─────────────────────────────────
   Ported from Loop's StandardRetrospectiveCorrection: rather than only
   learning ISF from an average of past corrections over days
   (personalCorrectionFactor above), this asks a much faster question —
   over just the last 30 minutes, how far off was the insulin+carb
   model's PREDICTED glucose movement from what actually happened? That
   gap ("discrepancy") is a live signal that today's effective
   sensitivity/absorption is running differently than the model assumes
   — illness, hormones, a bad infusion site, activity the log doesn't
   capture — and catches it within the hour instead of waiting for
   enough corrections to shift a multi-day rolling average.

   The discrepancy is used directly as an additive glucose effect
   (mmol/L, same units as the reading itself) rather than being run back
   through the correction factor — same as Loop's own implementation,
   which treats it as "glucose is moving faster/slower than modeled" and
   extrapolates that residual movement forward, decaying it out over
   RC_EFFECT_DURATION_MIN since an unexplained trend from half an hour
   ago says less and less about right now the further out it's projected.
   Set longer than the 2h hypo-forecast horizon on purpose — decayed to
   exactly zero by RC_EFFECT_DURATION_MIN would mean the forecast never
   actually felt any of it (a reduced-but-nonzero echo at 2h out is the
   whole point of using this to sharpen that specific forecast).
   ───────────────────────────────────────────────────────── */
const RETROSPECTION_INTERVAL_MIN = 30;  // Loop's own default lookback window
const RC_READING_TOLERANCE_MIN   = 10;  // how far a reading may sit from the target time and still count
const RC_EFFECT_DURATION_MIN     = 180; // the discrepancy's effect decays linearly to zero over this long — see note above on why it outlasts the 2h forecast horizon

// The glucose reading closest to targetMs, within toleranceMin — used to
// find "the reading from ~30 minutes ago" without requiring one to land
// on an exact 5-minute boundary (real CGM data doesn't always).
function nearestReading(readings, targetMs, toleranceMin) {
  let best = null, bestDiff = Infinity;
  for (const r of readings) {
    const diff = Math.abs(r.ms - targetMs);
    if (diff < bestDiff) { best = r; bestDiff = diff; }
  }
  return best && bestDiff <= toleranceMin * 60000 ? best : null;
}

// Computes the current retrospective-correction discrepancy. Withheld
// (discrepancy: null) rather than guessed when there's no reliable
// factor, no carb ratio, or the glucose readings bracketing the window
// aren't actually there — same "withhold rather than fake precision"
// posture as the rest of this engine.
function retrospectiveCorrection(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const curveOpts = insulinCurveOpts(settings);
  const carbRatio = modelCarbRatio(input, now) || Number(settings.carbRatio) || null;

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, modelOpts(input, now));
  if (factorResult.factor == null) {
    return { discrepancy: null, withheldReason: 'insufficient-history', factor: factorResult };
  }
  if (!carbRatio) {
    return { discrepancy: null, withheldReason: 'missing-carb-ratio', factor: factorResult };
  }

  const readings = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && !Number.isNaN(r.value) && r.ms <= nowMs)
    .sort((a, b) => a.ms - b.ms);

  const startMs = nowMs - RETROSPECTION_INTERVAL_MIN * 60000;
  const startReading = nearestReading(readings, startMs, RC_READING_TOLERANCE_MIN);
  const endReading = nearestReading(readings, nowMs, RC_READING_TOLERANCE_MIN);
  if (!startReading || !endReading || endReading.ms <= startReading.ms) {
    return { discrepancy: null, withheldReason: 'insufficient-recent-readings', factor: factorResult };
  }

  const factor = factorResult.factor;
  const actualChange = endReading.value - startReading.value;

  const insulinUnits = insulinEffectBetween(boluses, corrections, startReading.ms, endReading.ms, curveOpts);
  const carbGrams = carbEffectBetween(boluses, startReading.ms, endReading.ms, { duration: COB_DURATION_MINUTES });
  const modeledChange = -(insulinUnits * factor) + (carbGrams / carbRatio) * factor;

  return {
    discrepancy: actualChange - modeledChange,
    windowMinutes: minutesBetween(startReading.ms, endReading.ms),
    factor,
    factorSampleSize: factorResult.sampleSize,
    withheldReason: null,
  };
}

// The discrepancy's effect at `minutesFromNow`, decaying linearly to
// zero over effectDurationMin — 0 whenever discrepancy itself is
// unavailable, so callers can add this in unconditionally without a
// separate null check (an unavailable RC signal is a safe no-op, never
// a blocker for the prediction/suggestion it's enhancing).
function retrospectiveEffectAt(discrepancy, minutesFromNow, effectDurationMin = RC_EFFECT_DURATION_MIN) {
  if (discrepancy == null) return 0;
  const fraction = clamp(1 - minutesFromNow / effectDurationMin, 0, 1);
  return discrepancy * fraction;
}

/* ── 2h hypo forecast ──────────────────────────────────────────
   effective − insulinAction(120) − openWorkoutDrop(120) + carbAbsorption(120),
   converted to mmol/L via the personal correction factor / carb ratio.
   Withheld (not faked with a generic factor) when there isn't yet a
   trustworthy personal factor — consistent with "withhold rather than
   fake precision." Deliberately pessimistic: ties in tier assignment
   round toward the more cautious tier, and a time-of-day with a recent
   history of lows bumps the tier up regardless of the raw number. */
// Shared by hypoForecast2h and hyperForecast2h — both predict the same
// single forecastGlucose number (current effective glucose, projected
// HYPO_FORECAST_HORIZON_MIN out against active insulin/carbs/workout
// effect and a retrospective correction), they just classify it against
// opposite ends of the target range afterward. Keeping the projection
// itself in one place means a change to the model (a new input, a bug
// fix) can't accidentally apply to one direction and not the other.
function computeForecastCore(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const curveOpts = insulinCurveOpts(settings);

  const ctx = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  if (ctx.stale || ctx.effectiveGlucose == null) {
    return { withheldReason: 'stale-reading', context: ctx };
  }

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const mOpts = modelOpts(input, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, mOpts);
  if (factorResult.factor == null) {
    return { withheldReason: 'insufficient-history', context: ctx, factor: factorResult };
  }
  const factor = factorResult.factor;
  const applied = mOpts.model ? applyModel(mOpts.model, nowMs, mOpts) : null;
  const carbRatio = (applied && applied.carbRatio > 0 ? applied.carbRatio : null) || Number(settings.carbRatio) || null;
  const reasons = [...(factorResult.reasons || [])];

  const insulinActionUnits = insulinActionWithin(boluses, corrections, nowMs, HYPO_FORECAST_HORIZON_MIN, curveOpts);
  const carbAbsorptionGrams = carbAbsorptionWithin(boluses, nowMs, HYPO_FORECAST_HORIZON_MIN);

  const insulinDropMmol = insulinActionUnits * factor;
  const carbRiseMmol = carbRatio ? (carbAbsorptionGrams / carbRatio) * factor : 0;

  const workoutProfiles = buildWorkoutTypeProfiles(activities.workouts, glucoseHistory);
  const openWorkoutDropMmol = openWorkoutDropWithin(workoutProfiles, activities.workouts, nowMs, HYPO_FORECAST_HORIZON_MIN);

  // Learned model: an in-progress workout of a learned type drops at its
  // learned rate for the rest of the session (within the horizon), and the
  // forecast is shifted by this block's learned bias (capped ±1.0 mmol/L).
  const { liveExerciseDropMmol, forecastBiasShift, reasons: modelReasons } =
    modelForecastTerms(applied, mOpts.model, nowMs, HYPO_FORECAST_HORIZON_MIN);
  reasons.push(...modelReasons);

  // Retrospective correction: how far off the model's insulin+carb-only
  // prediction was over the last 30 minutes, extrapolated forward (and
  // decayed) to the forecast's own horizon — see the comment above
  // retrospectiveCorrection for why this is a useful addition on top of
  // the correction-factor learning above rather than a replacement for it.
  const rc = retrospectiveCorrection(input, now);
  const retrospectiveEffect = retrospectiveEffectAt(rc.discrepancy, HYPO_FORECAST_HORIZON_MIN);

  const rawForecastGlucose = ctx.effectiveGlucose - insulinDropMmol + carbRiseMmol - openWorkoutDropMmol
    - liveExerciseDropMmol + retrospectiveEffect + forecastBiasShift;
  // Floor matches projectedGlucoseCurve's existing Math.max(1, ...) for
  // the chart; ceiling is new — see FORECAST_GLUCOSE_MAX_MMOL above.
  const forecastGlucose = clamp(rawForecastGlucose, 1, FORECAST_GLUCOSE_MAX_MMOL);

  return {
    withheldReason: null, ctx, forecastGlucose,
    forecastCapped: forecastGlucose !== rawForecastGlucose,
    effectiveGlucose: ctx.effectiveGlucose,
    insulinDropMmol, carbRiseMmol, openWorkoutDropMmol, liveExerciseDropMmol, forecastBiasShift,
    retrospectiveEffect, retrospectiveDiscrepancy: rc.discrepancy,
    factor, factorSampleSize: factorResult.sampleSize,
    // For the alert wording: which factor the suggestion used ('learned' =
    // the learned model's block, factorSampleSize = its evidence count;
    // 'pump-setting' = the configured one), insulin on board, and the trend.
    factorSource: factorResult.source, factorBasis: factorResult.basis ?? null,
    factorAdjustments: factorResult.adjustments || [],
    iob: ctx.iob, trendPerMinute: ctx.trendPerMinute,
    currentGlucose: ctx.currentGlucose,
    reasons,
  };
}
// computeForecastCore's withheld branches key the dosingContext as
// `context` (matching hypoForecast2h/hyperForecast2h's own pre-refactor
// withheld shape); its success branch keys it `ctx` instead so callers
// can pull ctx.iob etc. without it also leaking into the final tier
// response below, which never included a context/ctx field before this
// split existed and shouldn't start now.
function stripCtx(core) {
  const { ctx, ...rest } = core;
  return rest;
}

function hypoForecast2h(input, now = Date.now()) {
  const { glucoseHistory = [], settings = {} } = input || {};
  const nowMs = toMs(now);
  const core = computeForecastCore(input, now);
  if (core.withheldReason) return { tier: null, ...core };

  const low = Number(settings.targetLow) || 4.5;
  const { forecastGlucose } = core;
  let tier;
  if (forecastGlucose <= low - 1) tier = 'high';
  else if (forecastGlucose <= low) tier = 'moderate';
  else if (forecastGlucose <= low + 1.5) tier = 'low';
  else tier = 'minimal';

  // Bump a tier if this time-of-day has had >=2 lows in recent history —
  // deliberately pessimistic per spec, regardless of how the raw number
  // lands — but only when the forecast itself is still on the lower/
  // normal side (below idealTarget). Without that ceiling, a forecast
  // confidently trending toward a HIGH (e.g. 9.1 mmol/L) could still get
  // bumped into "Slight risk" purely because this hour has crashed
  // before, which reads as actively wrong: a hypo-risk badge sitting
  // next to a number that isn't anywhere near hypo territory.
  const lookbackStart = nowMs - TIME_OF_DAY_LOOKBACK_DAYS * DAY_MS;
  const hourNow = hourOfDay(nowMs);
  const sameHourLows = (glucoseHistory || [])
    .map(r => ({ ms: toMs(r.time), value: Number(r.value) }))
    .filter(r => r.ms != null && r.ms >= lookbackStart && r.ms <= nowMs && hourOfDay(r.ms) === hourNow && r.value < low)
    .length;
  const idealTarget = Number(settings.idealTarget);
  const bumpCeiling = Number.isFinite(idealTarget) ? idealTarget : low + 3;
  const bumped = sameHourLows >= TIME_OF_DAY_BUMP_LOW_COUNT && forecastGlucose < bumpCeiling;
  if (bumped) {
    const order = ['minimal', 'low', 'moderate', 'high'];
    tier = order[Math.min(order.length - 1, order.indexOf(tier) + 1)];
  }

  return { tier, bumpedForTimeOfDay: bumped, ...stripCtx(core), withheldReason: null };
}

// Mirror of hypoForecast2h for the high side — same projected
// forecastGlucose, classified against targetHigh instead of targetLow,
// plus a suggested correction dose for the forecasted peak (not the
// current reading) using the same math suggestCorrectionDose uses:
// (forecast - idealTarget)/factor - current IOB, floored at 0 and capped
// at MAX_SUGGESTED_UNITS. Exists mainly so a predictive push notification
// can say "consider ~0.5u now" rather than just "you'll likely run high."
function hyperForecast2h(input, now = Date.now()) {
  const { settings = {} } = input || {};
  const core = computeForecastCore(input, now);
  if (core.withheldReason) return { tier: null, ...core };

  const high = Number(settings.targetHigh) || 10;
  const idealTarget = Number(settings.idealTarget);
  const { forecastGlucose, ctx, factor } = core;
  let tier;
  if (forecastGlucose >= high + 3) tier = 'high';
  else if (forecastGlucose >= high + 1.5) tier = 'moderate';
  else if (forecastGlucose >= high) tier = 'low';
  else tier = 'minimal';

  let suggestedUnits = null;
  if (tier !== 'minimal' && Number.isFinite(idealTarget) && factor >= MIN_RELIABLE_FACTOR) {
    const raw = (forecastGlucose - idealTarget) / factor - (ctx.iob || 0);
    suggestedUnits = roundDose(Math.min(MAX_SUGGESTED_UNITS, Math.max(0, raw)));
  }

  return { tier, suggestedUnits, ...stripCtx(core), withheldReason: null };
}

// Same model as hypoForecast2h, generalized into a curve for charting —
// projected glucose at each step from now out to the horizon, using
// active IOB/COB decay against the resolved correction factor. Openly
// approximate (a straight population-curve projection, not a real
// model-predictive forecast) and deliberately not extended past 2-3h,
// where compounding assumptions make it far less trustworthy.
function projectedGlucoseCurve(input, now = Date.now(), horizonMinutes = HYPO_FORECAST_HORIZON_MIN, stepMinutes = 15) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const curveOpts = insulinCurveOpts(settings);

  const ctx = dosingContext({ glucoseHistory, boluses, corrections, settings }, now);
  if (ctx.stale || ctx.effectiveGlucose == null) return [];

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const mOpts = modelOpts(input, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, mOpts);
  if (factorResult.factor == null) return [];

  const applied = mOpts.model ? applyModel(mOpts.model, nowMs, mOpts) : null;
  const carbRatio = (applied && applied.carbRatio > 0 ? applied.carbRatio : null) || Number(settings.carbRatio) || null;
  const rc = retrospectiveCorrection(input, now);
  // Same terms as computeForecastCore, per step, so the chart's 2h point is the alert's forecast.
  const workoutProfiles = buildWorkoutTypeProfiles(activities.workouts, glucoseHistory);
  const points = [];
  for (let t = 0; t <= horizonMinutes; t += stepMinutes) {
    const insulinDropMmol = insulinActionWithin(boluses, corrections, nowMs, t, curveOpts) * factorResult.factor;
    const carbAbsorptionGrams = carbAbsorptionWithin(boluses, nowMs, t);
    const carbRiseMmol = carbRatio ? (carbAbsorptionGrams / carbRatio) * factorResult.factor : 0;
    const retrospectiveEffect = retrospectiveEffectAt(rc.discrepancy, t);
    const openWorkoutDropMmol = openWorkoutDropWithin(workoutProfiles, activities.workouts, nowMs, t);
    const m = modelForecastTerms(applied, mOpts.model, nowMs, t);
    const value = clamp(ctx.effectiveGlucose - insulinDropMmol + carbRiseMmol - openWorkoutDropMmol
      - m.liveExerciseDropMmol + retrospectiveEffect + m.forecastBiasShift, 1, FORECAST_GLUCOSE_MAX_MMOL);
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
    const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, modelOpts(input, now));
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
const UNPLUG_BOLUS_MIN_DURATION_MIN    = 45;   // shorter disconnects aren't worth pre-bolusing for
const UNPLUG_BOLUS_COVERAGE_FRACTION   = 0.5;  // cover roughly half the missed basal, not all of it — exercise (even light) still raises insulin sensitivity, so fully replacing it risks a low mid-session instead
const UNPLUG_BOLUS_MIN_SUGGESTED_UNITS = 0.5;  // below this it's not worth the hassle/risk of an extra dose

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

// Only relevant on the hyper side of a disconnect, and only when the low
// side is clear — never suggests extra insulin alongside a hypo warning.
// Deliberately covers only about half the missed basal rather than all
// of it: exercise raises insulin sensitivity even at low intensity, so a
// straight 1:1 replacement risks trading a high for a low mid-session,
// which is a worse outcome to hand someone about to go swimming. Short
// disconnects are skipped entirely — a 20-minute low-intensity walk
// isn't worth an extra dose over.
function preventativeUnplugBolusAdvice(missedUnits, durationMin, hyperRisk, hypoRisk) {
  if (hyperRisk === 'low' || hypoRisk !== 'low') return null;
  if (durationMin < UNPLUG_BOLUS_MIN_DURATION_MIN) return null;
  const suggestedUnits = roundDose(missedUnits * UNPLUG_BOLUS_COVERAGE_FRACTION);
  if (suggestedUnits < UNPLUG_BOLUS_MIN_SUGGESTED_UNITS) return null;
  return {
    suggestedUnits,
    message: `A small ~${suggestedUnits}u pre-bolus a little before you disconnect (roughly half the missed basal) may help hold the line — exercise still raises insulin sensitivity even at low intensity, so covering all of it risks a low instead.`,
  };
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
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, modelOpts(input, now));

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

  // Only sized/offered once a real correction factor exists — same
  // guard preventativeCarbAdvice already applies for the same reason.
  let bolusAdvice = null;
  if (factorResult.factor != null) {
    bolusAdvice = preventativeUnplugBolusAdvice(missedUnits, durationMin, hyperRisk, hypoRisk);
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
    bolusAdvice,
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
   With a fresh learned model (applyModel): carbs / the model's carb
   ratio for this time of day (boost and active modifiers applied, held
   within ±30% of the pump value). Without one: the plain pump carb
   ratio. The old weighted imitation of past meal boluses is gone — it
   copied past doses (good or bad) rather than learning a ratio. */
function suggestMealDose(input, newCarbs, now = Date.now()) {
  const { settings = {} } = input || {};
  const o = modelOpts(input, now);
  const applied = o.model ? applyModel(o.model, now, o) : null;
  if (applied && applied.carbRatio > 0) {
    const src = doseSource(applied.crSource);
    const raw = Math.max(0, newCarbs / applied.carbRatio);
    return {
      source: src === 'pump-setting' ? 'manual-carb-ratio' : src,
      suggestedUnits: roundDose(Math.min(MAX_SUGGESTED_UNITS, raw)),
      cappedAt10: raw > MAX_SUGGESTED_UNITS,
      carbRatio: applied.carbRatio,
      sampleSize: applied.crSampleSize,
      multiplier: applied.multiplier, adjustments: applied.adjustments,
      fromModel: true,
      reasons: applied.crReasons,
      withheldReason: null,
    };
  }
  return fallbackMealDose(newCarbs, settings, 'no-model');
}
function fallbackMealDose(newCarbs, settings, reason) {
  const carbRatio = Number(settings.carbRatio);
  if (!carbRatio) return { source: 'none', suggestedUnits: null, withheldReason: 'missing-carb-ratio', reasons: ['no carb ratio set'] };
  return {
    source: 'manual-carb-ratio',
    suggestedUnits: roundDose(Math.min(MAX_SUGGESTED_UNITS, Math.max(0, newCarbs / carbRatio))),
    cappedAt10: newCarbs / carbRatio > MAX_SUGGESTED_UNITS,
    withheldReason: reason,
    reasons: [`carb ratio ${fmt1(carbRatio)} from your pump setting`],
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

// opts.model / opts.nowMs: with a fresh learned model whose high-fat meals
// mostly rise late (meals.delayedRiseHighFat rate >= 0.5, n >= 5), a 20g+
// fat meal's split carries that as its reason (learnedLateRise: true).
function splitDoseGuide(fatGrams, proteinGrams, settings, opts = {}) {
  const fat = Number(fatGrams) || 0;
  const protein = Number(proteinGrams) || 0;
  const curve = insulinCurveOpts(settings);
  const fastActing = curve.peak <= 60; // Fiasp/Lyumjev-class peak vs Novorapid-class
  const { model = null, nowMs = Date.now() } = opts || {};
  const late = modelFresh(model, nowMs) ? asModel(model).meals.delayedRiseHighFat : null;
  const learnedLateRise = isObj(late) && isNum(late.rate) && late.rate >= MODEL_LATE_RISE_RATE && (late.n || 0) >= MODEL_LATE_RISE_MIN_N;
  const reasons = learnedLateRise && fat >= SPLIT_DOSE_FAT_LOW_G
    ? [`your high-fat meals usually rise after 2½h (${late.n} meals)`] : [];
  const learned = { learnedLateRise: reasons.length > 0, reasons };

  if (fat < SPLIT_DOSE_FAT_LOW_G) {
    return {
      tier: 'single', fatGrams: fat, proteinGrams: protein,
      upfrontPct: 1, delayMinutes: null, highProteinFlag: false,
      message: 'Under 20g fat — a normal single dose with your usual pre-bolus timing should be fine.',
      ...learned,
    };
  }
  if (fat < SPLIT_DOSE_FAT_HIGH_G) {
    const delayMinutes = fastActing ? 90 : 120;
    return {
      tier: 'moderate-fat', fatGrams: fat, proteinGrams: protein,
      upfrontPct: SPLIT_DOSE_MODERATE_UPFRONT_PCT, delayMinutes, highProteinFlag: false,
      message: `20-35g fat slows digestion enough to cause a second spike — dose ${Math.round(SPLIT_DOSE_MODERATE_UPFRONT_PCT * 100)}% now, the rest ${fastActing ? '~90min' : '~2h'} later.`
        + (learned.learnedLateRise ? ` Your own high-fat meals usually rise after 2½h (${late.n} meals), so the split matters here.` : ''),
      ...learned,
    };
  }
  const highProteinFlag = protein >= SPLIT_DOSE_HIGH_PROTEIN_G;
  const delayMinutes = fastActing ? 150 : 180;
  return {
    tier: 'high-fat', fatGrams: fat, proteinGrams: protein,
    upfrontPct: SPLIT_DOSE_HIGH_UPFRONT_PCT, delayMinutes, highProteinFlag,
    message: `35g+ fat — dose 50% now, 50% ${fastActing ? '~2.5h' : '~3h'} later.`
      + (highProteinFlag ? ' High protein too, so you may need more total insulin than usual — add that extra to the later dose, not this one.' : '')
      + (learned.learnedLateRise ? ` Your own high-fat meals usually rise after 2½h (${late.n} meals), so the split matters here.` : ''),
    ...learned,
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
  const guide = splitDoseGuide(fat, protein, settings, { model: input.model, nowMs });

  const ctx = dosingContext(input, now);
  if (ctx.stale) {
    return { suggestedUnits: null, withheldReason: 'stale-reading', guide, upfrontUnits: null, delayedUnits: null, personalized: false, reasons: [...guide.reasons] };
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

    // The old meal-outcome nudge only on the no-model path: a learned carb
    // ratio already comes from hindsight doses, so nudging it again would
    // double-count (and could add up to 20% more insulin).
    if (!carbBase.fromModel && comparable.length >= MACRO_HISTORY_MIN_SAMPLE) {
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
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings, modelOpts(input, now));
  const correctionAvailable = Number.isFinite(idealTarget) && factorResult.factor != null;
  const correctionUnits = correctionAvailable ? (ctx.effectiveGlucose - idealTarget) / factorResult.factor : 0;

  let total = carbUnits + correctionUnits - ctx.iob;
  const zeroedByFloor = total < 0;
  total = Math.max(0, total);

  if (guide.highProteinFlag) total *= (1 + SPLIT_DOSE_PROTEIN_BUMP_PCT);
  const cappedAt10 = total > MAX_SUGGESTED_UNITS;
  total = Math.min(MAX_SUGGESTED_UNITS, total);

  const upfrontUnits = roundDose(total * guide.upfrontPct);
  const delayedUnits = guide.tier === 'single' ? 0 : Math.max(0, roundDose(total - upfrontUnits));
  const low = Number(settings.targetLow) || 4.5;

  return {
    suggestedUnits: roundDose(total),
    cappedAt10,
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
    reasons: [...new Set([...(carbBase.reasons || []), ...(correctionAvailable ? factorResult.reasons || [] : []), ...guide.reasons])],
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

// Finer 3h-block version of the same time-of-day split, used for the
// basal/pump-profile review specifically — real pump basal segments are
// commonly programmed at this granularity (a single 6h "Night" rate
// often actually needs splitting, e.g. a stronger rate 03:00-06:00 for
// dawn phenomenon than 00:00-03:00), so the review should be able to
// suggest at the same resolution someone would actually edit their
// pump profile in. basalWindowReview still counts at most one clean
// instance per calendar day per bucket regardless of bucket width, so
// this doesn't reduce the sample-size ceiling — it only narrows what
// window each instance is measured over.
const REGIMEN_TOD_BUCKETS = [
  { label: '00:00–03:00', from: 0,  to: 3 },
  { label: '03:00–06:00', from: 3,  to: 6 },
  { label: '06:00–09:00', from: 6,  to: 9 },
  { label: '09:00–12:00', from: 9,  to: 12 },
  { label: '12:00–15:00', from: 12, to: 15 },
  { label: '15:00–18:00', from: 15, to: 18 },
  { label: '18:00–21:00', from: 18, to: 21 },
  { label: '21:00–24:00', from: 21, to: 24 },
];

// With a learned model on the input: the model's 3h blocks (what doses
// actually use) instead of the old averaged display cells.
function sensitivityMap(input, now = Date.now()) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {} } = input || {};
  const nowMs = toMs(now);
  const model = asModel(input?.model);
  if (model) {
    return model.blocks.map(b => {
      const isf = isObj(b.isf) ? b.isf : {}, cr = isObj(b.carbRatio) ? b.carbRatio : {};
      return {
        timeOfDay: b.label,
        isf: isf.value ?? null, carbRatio: cr.value ?? null,
        pumpIsf: isf.pump ?? null, pumpCr: cr.pump ?? null,
        n: isf.n ?? 0, source: isf.source ?? null,
        outsideBand: !!(isf.outsideBand || cr.outsideBand),
      };
    });
  }
  // Same MIN/MAX_RELIABLE_FACTOR plausibility bounds personalCorrectionFactor
  // and analyzePatterns' cleanInWindow use (see personalCorrectionFactor's
  // comment) — without them a tiny-unit correction whose glucose drop was
  // actually caused by something else nearby produces a wildly inflated
  // dropPerUnit (e.g. 24+ mmol/L/u, clinically impossible) that skews
  // whichever time-of-day cell it lands in.
  const clean = resolveCorrections(corrections, glucoseHistory, boluses, now)
    .map(c => ({ ...c, _ms: toMs(c.time) }))
    .filter(c => c._ms != null && c._ms <= nowMs && c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit)
      && c.dropPerUnit >= MIN_RELIABLE_FACTOR && c.dropPerUnit <= MAX_RELIABLE_FACTOR);

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
function prescribedRegimenTable(pumpProfile, buckets = REGIMEN_TOD_BUCKETS) {
  const segments = pumpProfile?.default;
  if (!segments?.length) return null;
  return buckets.map(bucket => ({
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

   REGIMEN_LOOKBACK_DAYS was 7 for a long time with no real justification
   for that number over any other — and 7 real days is a bad unit to
   require a clean, exercise-free, IOB/COB-free instance of every single
   3h block within, especially for someone active most days: one unusually
   disrupted week (illness, travel, an eventful few days) can leave every
   block withheld even though calmer days exist just outside the window.
   21 gives the same strict per-block gating (still >=4 clean instances,
   still direction-consistency-checked) far more chances to find them,
   while staying under what a live Nightscout feed can even provide
   (diabetes-sync.js caps at 31 days server-side).
   ═══════════════════════════════════════════════════════════ */
const REGIMEN_LOOKBACK_DAYS            = 21;
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
// Given the profile-switch timeline adaptProfileSwitches produces
// (sorted ascending by ms), which named profile was actually active at a
// given moment — the most recent switch at or before it, or the earliest
// known profile if `ms` predates every recorded switch (a fetch window
// can start mid-profile, before any switch happened to fall inside it).
function resolveActiveProfileAt(profileSwitches, ms) {
  if (!profileSwitches?.length) return null;
  let active = profileSwitches[0].profileName;
  for (const s of profileSwitches) {
    if (s.ms <= ms) active = s.profileName; else break;
  }
  return active;
}

function basalWindowReview(input, now = Date.now(), profileFilter = null) {
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const readings = sortedReadings(glucoseHistory, windowStart, nowMs);
  const curveOpts = insulinCurveOpts(settings);
  const matchesProfile = (ms) => !profileFilter || profileFilter(ms);
  // Same post-exercise exclusion sensitivityMap/patternExerciseSensitivity/
  // carbRatioReview already use — a "clean" window here is meant to isolate
  // pure basal drift, but exercise (a morning strength session, say) drops
  // glucose on its own for hours afterward. Without this, that drop gets
  // misread as "basal is too strong here" when it's actually the workout,
  // and for someone who already runs a deliberately lower basal ahead of
  // training specifically to blunt that effect, this would recommend
  // cutting it even further for the wrong reason.
  const isNearExercise = (ms) => (activities.workouts || []).some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });

  const resolvedCorrections = resolveCorrections(corrections, glucoseHistory, boluses, now);
  const factorResult = resolveCorrectionFactor(resolvedCorrections, settings);

  // Midnight-aligned, NOT windowStart-aligned — windowStart is exactly
  // `now` minus a whole number of days, so it preserves now's own
  // time-of-day (e.g. call this at 07:35 and windowStart lands at 07:35,
  // 7 days back). Stepping by DAY_MS from there would keep every
  // "dayStart" at 07:35 too, so a bucket like {from:0,to:3} labeled
  // "00:00–03:00" would actually select 07:35-10:35 — silently shifted
  // by whatever time of day the function happens to run at, rather than
  // the true calendar hours the label promises. Flooring to the most
  // recent UTC midnight at or before windowStart fixes the anchor; the
  // readings array is already bounded to [windowStart, nowMs] so an
  // extra partial day at the start just yields fewer/no matching
  // readings there rather than double-counting anything.
  const firstMidnight = Math.floor(windowStart / DAY_MS) * DAY_MS;

  return REGIMEN_TOD_BUCKETS.map(bucket => {
    const windowHours = bucket.to - bucket.from;
    const instances = [];

    for (let dayStart = firstMidnight; dayStart < nowMs; dayStart += DAY_MS) {
      const wStart = dayStart + bucket.from * 3600000;
      const wEnd = dayStart + bucket.to * 3600000;
      if (wEnd > nowMs || wEnd < windowStart) continue;

      const windowReadings = readings.filter(r => r.ms >= wStart && r.ms <= wEnd);
      const expectedCount = (windowHours * 60) / 5; // ~5min CGM cadence
      if (windowReadings.length < expectedCount * REGIMEN_MIN_COVERAGE_PCT) continue;

      let clean = true;
      for (let t = wStart; t <= wEnd; t += 30 * 60000) {
        if (activeInsulin(boluses, corrections, t, curveOpts) > REGIMEN_CLEAN_IOB_MAX || carbsOnBoard(boluses, t) > 0 || isNearExercise(t) || !matchesProfile(t)) {
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
    // Applied to the same observed avgBasalRate the % itself was derived
    // from (not the pump-programmed rate, which may differ from what was
    // actually delivered) — internally consistent, and rounded to 0.05u/hr,
    // the finest increment most pumps actually accept.
    const suggestedBasalRate = Math.round(avgBasalRate * (1 + suggestedPctChange / 100) * 20) / 20;

    return {
      timeOfDay: bucket.label, n: instances.length, avgDrift, avgBasalRate,
      suggestedPctChange, suggestedBasalRate, direction: suggestedPctChange > 0 ? 'increase' : 'decrease',
      cappedAtLimit: Math.abs(rawPctChange) > REGIMEN_MAX_PCT_CHANGE,
      withheldReason: null,
    };
  });
}

// Same carb-ratio check as carbRatioReview below, but scoped to each 3h
// block independently instead of pooling the whole week — meals are far
// sparser than background CGM readings, so most blocks (especially
// overnight ones nobody eats in) will honestly come back
// insufficient-meals rather than force a number out of 1-2 data points.
function carbRatioByWindowReview(input, now = Date.now(), profileFilter = null) {
  const { glucoseHistory = [], boluses = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const carbRatio = Number(settings.carbRatio);

  if (!carbRatio) {
    return REGIMEN_TOD_BUCKETS.map(bucket => ({ timeOfDay: bucket.label, n: 0, withheldReason: 'missing-carb-ratio' }));
  }

  const workouts = activities.workouts || [];
  const isNearExercise = ms => workouts.some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });
  const matchesProfile = (ms) => !profileFilter || profileFilter(ms);

  const meals = (boluses || [])
    .filter(b => Number(b.carbs) > 0 && Number(b.units) > 0)
    .map(b => ({ ...b, _ms: toMs(b.time) }))
    .filter(b => b._ms != null && b._ms >= windowStart && b._ms <= nowMs && !isNearExercise(b._ms) && matchesProfile(b._ms));

  return REGIMEN_TOD_BUCKETS.map(bucket => {
    const inBucket = meals.filter(m => { const h = hourOfDay(m._ms); return h >= bucket.from && h < bucket.to; });
    const outcomes = inBucket.map(m => {
      const window = readings.filter(r => r.ms >= m._ms && r.ms <= m._ms + 4 * 3600000);
      if (!window.length) return null;
      if (window.some(r => r.value < low)) return -1;
      if (Math.max(...window.map(r => r.value)) > high) return 1;
      return 0;
    }).filter(b => b != null);

    if (outcomes.length < REGIMEN_MIN_CLEAN_SAMPLES) {
      return { timeOfDay: bucket.label, n: outcomes.length, currentRatio: carbRatio, withheldReason: 'insufficient-meals' };
    }

    const highCount = outcomes.filter(b => b === 1).length;
    const lowCount = outcomes.filter(b => b === -1).length;
    const consistency = Math.max(highCount, lowCount) / outcomes.length;
    const avgBias = mean(outcomes);

    if (consistency < REGIMEN_MIN_DIRECTION_CONSISTENCY || Math.abs(avgBias) < REGIMEN_MIN_OUTCOME_BIAS) {
      return { timeOfDay: bucket.label, n: outcomes.length, currentRatio: carbRatio, withheldReason: 'no-consistent-signal' };
    }

    const rawPctChange = clamp(-avgBias * 20, -100, 100);
    const suggestedPctChange = clamp(rawPctChange, -REGIMEN_MAX_PCT_CHANGE, REGIMEN_MAX_PCT_CHANGE);
    const suggestedRatio = Math.round(carbRatio * (1 + suggestedPctChange / 100) * 2) / 2;

    return {
      timeOfDay: bucket.label, n: outcomes.length, currentRatio: carbRatio, suggestedRatio,
      suggestedPctChange, direction: suggestedPctChange < 0 ? 'tighten' : 'loosen',
      cappedAtLimit: Math.abs(rawPctChange) > REGIMEN_MAX_PCT_CHANGE,
      withheldReason: null,
    };
  });
}

// Correction-factor equivalent of the two reviews above: within each 3h
// block, do clean (resolved, no-carb-interference, plausibly-bounded —
// same MIN/MAX_RELIABLE_FACTOR guard used everywhere else in this file)
// corrections consistently imply a different ISF than what's currently
// programmed? Needs the same sample-size floor and >=70% same-direction
// agreement as the basal/carb-ratio checks before it'll suggest anything.
//
// `prescribedTable` (optional, shape: prescribedRegimenTable's output) lets
// the comparison use the REAL per-block correction factor for whichever
// pump profile is actually being reviewed, instead of one flat
// settings.correctionFactor for the whole day — a single blended number
// can sit far from what's actually programmed in any given 3h block (a
// pump profile that varies ISF by time of day, which most do), which
// would silently mis-anchor both the "current" this reports AND the
// suggested value derived from it. Falls back to the flat setting when no
// table is available, so this stays usable without pump-profile data.
function correctionFactorByWindowReview(input, now = Date.now(), profileFilter = null, prescribedTable = null) {
  const { glucoseHistory = [], boluses = [], corrections = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const fallbackFactor = Number(settings.correctionFactor) || null;
  const currentFactorFor = (bucketLabel) => {
    const rx = prescribedTable?.find(p => p.timeOfDay === bucketLabel)?.correctionFactor;
    return Number.isFinite(rx) ? rx : fallbackFactor;
  };

  if (!prescribedTable?.length && !fallbackFactor) {
    return REGIMEN_TOD_BUCKETS.map(bucket => ({ timeOfDay: bucket.label, n: 0, withheldReason: 'missing-correction-factor' }));
  }

  // Same post-exercise exclusion as basalWindowReview/carbRatioByWindowReview
  // — a correction taken while still sensitized from an earlier workout
  // isn't representative of this block's baseline ISF, the same way
  // sensitivityMap keeps post-exercise corrections in their own separate
  // context rather than blending them into "rest."
  const isNearExercise = (ms) => (activities.workouts || []).some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });
  const matchesProfile = (ms) => !profileFilter || profileFilter(ms);

  const clean = resolveCorrections(windowFilter(corrections, 'time', windowStart, nowMs), glucoseHistory, boluses, now)
    .map(c => ({ ...c, _ms: toMs(c.time) }))
    .filter(c => c._ms != null && c.resolved && !c.carbInterference && Number.isFinite(c.dropPerUnit)
      && c.dropPerUnit >= MIN_RELIABLE_FACTOR && c.dropPerUnit <= MAX_RELIABLE_FACTOR
      && !isNearExercise(c._ms) && matchesProfile(c._ms));

  return REGIMEN_TOD_BUCKETS.map(bucket => {
    const currentFactor = currentFactorFor(bucket.label);
    if (!currentFactor) {
      return { timeOfDay: bucket.label, n: 0, withheldReason: 'missing-correction-factor' };
    }
    const inBucket = clean.filter(c => { const h = hourOfDay(c._ms); return h >= bucket.from && h < bucket.to; });
    if (inBucket.length < REGIMEN_MIN_CLEAN_SAMPLES) {
      return { timeOfDay: bucket.label, n: inBucket.length, currentFactor, withheldReason: 'insufficient-clean-corrections' };
    }

    const avgDropPerUnit = mean(inBucket.map(c => c.dropPerUnit));
    const pctChange = ((avgDropPerUnit - currentFactor) / currentFactor) * 100;
    const aboveCount = inBucket.filter(c => c.dropPerUnit > currentFactor).length;
    const belowCount = inBucket.filter(c => c.dropPerUnit < currentFactor).length;
    const consistency = Math.max(aboveCount, belowCount) / inBucket.length;

    if (Math.abs(pctChange) < 15 || consistency < REGIMEN_MIN_DIRECTION_CONSISTENCY) {
      return { timeOfDay: bucket.label, n: inBucket.length, avgDropPerUnit, currentFactor, withheldReason: 'no-consistent-signal' };
    }

    const suggestedPctChange = clamp(pctChange, -REGIMEN_MAX_PCT_CHANGE, REGIMEN_MAX_PCT_CHANGE);
    const suggestedFactor = Math.round(currentFactor * (1 + suggestedPctChange / 100) * 20) / 20;

    return {
      timeOfDay: bucket.label, n: inBucket.length, avgDropPerUnit, currentFactor, suggestedFactor,
      suggestedPctChange, direction: suggestedFactor > currentFactor ? 'increase' : 'decrease',
      cappedAtLimit: Math.abs(pctChange) > REGIMEN_MAX_PCT_CHANGE,
      withheldReason: null,
    };
  });
}

// Whole-week carb-ratio check: did meals dosed with the current ratio
// consistently run high (ratio too loose) or low (too tight)? Excludes
// meals near exercise, same as the meal-dose/pattern checks elsewhere.
// Kept as a fallback reference alongside carbRatioByWindowReview above —
// a whole week pools enough meals to say something even on weeks where
// no single 3h block individually clears the sample-size floor.
function carbRatioReview(input, now = Date.now(), profileFilter = null) {
  const { glucoseHistory = [], boluses = [], activities = {}, settings = {} } = input || {};
  const nowMs = toMs(now);
  const windowStart = nowMs - REGIMEN_LOOKBACK_DAYS * DAY_MS;
  const readings = sortedReadings(glucoseHistory, -Infinity, nowMs);
  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const carbRatio = Number(settings.carbRatio);
  const matchesProfile = (ms) => !profileFilter || profileFilter(ms);

  const workouts = activities.workouts || [];
  const isNearExercise = ms => workouts.some(w => {
    const endMs = toMs(w.endTime) ?? toMs(w.startTime);
    return endMs != null && ms >= endMs && ms <= endMs + 8 * 3600000;
  });

  const meals = (boluses || [])
    .filter(b => Number(b.carbs) > 0 && Number(b.units) > 0)
    .map(b => ({ ...b, _ms: toMs(b.time) }))
    .filter(b => b._ms != null && b._ms >= windowStart && b._ms <= nowMs && !isNearExercise(b._ms) && matchesProfile(b._ms));

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
  const prescribedTable = input?.pumpProfile ? prescribedRegimenTable(input.pumpProfile) : null;
  return {
    basalByWindow: basalWindowReview(input, now),
    carbRatioByWindow: carbRatioByWindowReview(input, now),
    correctionFactorByWindow: correctionFactorByWindowReview(input, now, null, prescribedTable),
    carbRatio: carbRatioReview(input, now),
  };
}

// Nightscout's own profile-switch names ("Mo", "Thur", ...) mapped to the
// matching segment array in the pump-profile object (keyed 'default' /
// 'thu' — same convention app.js's dxProfileSegments already uses for the
// UI). Anything unrecognized falls back to 'default'.
function pumpProfileSegmentsForName(pumpProfile, name) {
  const n = String(name || '').toLowerCase();
  return (n.startsWith('thu') ? pumpProfile?.thu : pumpProfile?.default) || null;
}

// Same three per-block reviews as regimenReview, but run once per
// distinct named pump profile instead of pooling every day together —
// for anyone who deliberately switches profiles (an exercise-day profile,
// a low-medication-week profile, whatever the reason), pooling hides
// the fact that two different settings are actually in play on different
// days and blends their outcomes into one misleading average.
// input.profileSwitches (from nightscout-adapter's adaptProfileSwitches)
// carries the real timeline of which profile was active when — this
// doesn't guess *why* a day used one profile over another, it just
// respects whatever the user already decided by actually switching.
// Falls back to a single 'default' bucket (regimenReview's pooled
// result) when no switch history is available, so this stays a strict
// superset of the older behavior rather than a breaking change.
function regimenReviewByProfile(input, now = Date.now()) {
  const profileSwitches = input?.profileSwitches || [];
  if (!profileSwitches.length) {
    return { profiles: ['default'], byProfile: { default: regimenReview(input, now) } };
  }

  const profiles = [...new Set(profileSwitches.map(s => s.profileName))];
  const byProfile = {};
  for (const name of profiles) {
    const profileFilter = (ms) => resolveActiveProfileAt(profileSwitches, ms) === name;
    const segments = pumpProfileSegmentsForName(input?.pumpProfile, name);
    const prescribedTable = segments ? prescribedRegimenTable({ default: segments }) : null;
    byProfile[name] = {
      basalByWindow: basalWindowReview(input, now, profileFilter),
      carbRatioByWindow: carbRatioByWindowReview(input, now, profileFilter),
      correctionFactorByWindow: correctionFactorByWindowReview(input, now, profileFilter, prescribedTable),
      carbRatio: carbRatioReview(input, now, profileFilter),
    };
  }
  return { profiles, byProfile };
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

function forecastAccuracyScored(input, now) {
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
  return scored;
}

function forecastAccuracy(input, now = Date.now()) {
  const scored = forecastAccuracyScored(input, now);
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

// Mean forecast error (predicted − actual) per 3h London block, for the
// learner to store as model.forecastBias. Replayed WITHOUT any bias already
// in the model, so the stored bias doesn't feed on itself.
function forecastAccuracyByBlock(input, now = Date.now()) {
  const model = isObj(input?.model) ? { ...input.model, forecastBias: [] } : input?.model;
  // modelReplay: past forecasts are replayed against today's model, which is
  // "future-dated" relative to them — allowed here only.
  const scored = forecastAccuracyScored({ ...input, model, modelReplay: true }, now);
  return REGIMEN_TOD_BUCKETS.map(bk => {
    const errs = scored.filter(x => { const h = londonParts(x.t).hour; return h >= bk.from && h < bk.to; }).map(x => x.error);
    return { label: bk.label, from: bk.from, to: bk.to, bias: errs.length ? mean(errs) : null, n: errs.length };
  });
}

/* ═══════════════════════════════════════════════════════════
   STAGE 8 — Learning
   Episode-based learning: each logged event (a correction here) is
   scored once its window has fully elapsed, by fitting the WHOLE
   glucose curve over the window rather than a single reading at 3h.
   Every logged insulin source absorbed in the window counts — prior
   IOB from meal-bolus tails, other corrections, Control-IQ auto-boluses
   and temp-basal deviation from the programmed schedule — because
   ignoring prior IOB was shown to bias ISF ~3x.
   ═══════════════════════════════════════════════════════════ */

const EPISODE_STEP_MIN          = 5;    // CGM cadence the fit expects
const CGM_LAG_MINUTES           = 10;   // interstitial/sensor lag behind blood glucose
const EPISODE_MIN_READING_SHARE = 0.7;  // n < 70% of expected readings -> too-few-readings
const EPISODE_MAX_GAP_MIN       = 20;   // any gap longer -> sensor-gap
const EPISODE_RISE_MMOL         = 2.0;  // residual rise that counts as unexplained
const EPISODE_RISE_MIN          = 30;   // ...sustained this long
const EPISODE_SNACK_MIN_GAIN    = 0.6;  // candidate unlogged-carb term must explain >= 60% of the residual
const COMPRESSION_DROP_MMOL     = 2.0;
const COMPRESSION_RECOVER_MMOL  = 1.5;
const COMPRESSION_WINDOW_MIN    = 45;

// One cached formatter: londonHM() builds a fresh Intl formatter per call,
// which is too slow for the per-record schedule lookups below.
const _londonPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const _londonPartsCache = new Map();
function londonParts(ms) {
  const key = Math.floor(ms / 60000);
  let v = _londonPartsCache.get(key);
  if (!v) {
    const parts = _londonPartsFmt.formatToParts(new Date(key * 60000));
    const get = t => parts.find(p => p.type === t).value;
    v = { hour: parseInt(get('hour'), 10), minute: parseInt(get('minute'), 10), weekday: get('weekday') };
    if (_londonPartsCache.size > 200000) _londonPartsCache.clear();
    _londonPartsCache.set(key, v);
  }
  return v;
}

// UTC ms of a London wall-clock hour on the London calendar date containing
// ms (BST or GMT; the offset is read at that hour, so 06:00 on a
// clock-change night is 5 or 7 hours after 00:00).
const _londonDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
function londonClockMs(ms, hour) {
  const [y, m, d] = _londonDateFmt.format(new Date(ms)).split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, hour);
  return utc - ((londonParts(utc).hour - hour + 24) % 24) * 3600000;
}

// Pump profile segments sorted once per profile object.
const _sortedSegCache = new WeakMap();
function sortedProfileSegments(pumpProfile) {
  const segs = pumpProfile?.default;
  if (!segs?.length) return null;
  let sorted = _sortedSegCache.get(segs);
  if (!sorted) {
    sorted = [...segs].map(s => ({ ...s, _h: toHourDecimal(s.time) })).sort((a, b) => a._h - b._h);
    _sortedSegCache.set(segs, sorted);
  }
  return sorted;
}

// Pump-programmed value of `field` in force at a London clock time.
function profileValueAt(pumpProfile, ms, field) {
  const sorted = sortedProfileSegments(pumpProfile);
  if (!sorted) return null;
  const { hour, minute } = londonParts(ms);
  const h = hour + minute / 60;
  let val = null;
  for (const s of sorted) if (s._h <= h && s[field] != null) val = Number(s[field]);
  if (val == null) { const last = sorted[sorted.length - 1]; val = last[field] != null ? Number(last[field]) : null; }
  return val;
}
function hasProfileField(pumpProfile, field) {
  return !!sortedProfileSegments(pumpProfile)?.some(s => s[field] != null && Number.isFinite(Number(s[field])));
}

/* ── Prepared (indexed) learning input ────────────────────────
   Scoring many episodes against months of history must not rescan the
   whole history per episode (Edge Function CPU budget). prepareLearningInput
   sorts + dedupes glucose and basal once, with numeric ms, so each window
   is a binary-searched slice. Every Stage 8 function accepts either a raw
   input or a prepared one (marker __prepared). */
function lowerBoundMs(arr, ms) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ms < ms) lo = mid + 1; else hi = mid; }
  return lo;
}
function sliceByMs(arr, fromMs, toMsVal) {   // items with fromMs <= ms <= toMsVal
  return arr.slice(lowerBoundMs(arr, fromMs), lowerBoundMs(arr, toMsVal + 1));
}
function prepareBasal(basalDoses) {
  if (basalDoses && basalDoses.__preparedBasal) return basalDoses;
  const list = [];
  let maxDurMs = 0;
  for (const d of basalDoses || []) {
    const ms = toMs(d.time);
    if (ms == null) continue;
    const dur = Number(d.durationMin) > 0 ? Number(d.durationMin) : EPISODE_STEP_MIN;
    maxDurMs = Math.max(maxDurMs, dur * 60000);
    list.push({ ms, durMs: dur * 60000, units: Number(d.units) || 0 });
  }
  list.sort((a, b) => a.ms - b.ms);
  return { __preparedBasal: true, list, maxDurMs };
}
function prepareDoses(doses) {
  return (doses || []).map(d => ({ ...d, time: toMs(d.time), ms: toMs(d.time) }))
    .filter(d => d.ms != null).sort((a, b) => a.ms - b.ms);
}
// macroMealLog { time | eaten_at, fat, protein } -> sorted { ms, fat, protein } (null when not logged)
function prepareMacroMeals(log) {
  const num = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  return (log || []).map(m => ({ ms: toMs(m.time ?? m.eaten_at), fat: num(m.fat ?? m.fat_g), protein: num(m.protein ?? m.protein_g) }))
    .filter(m => m.ms != null).sort((x, y) => x.ms - y.ms);
}
function prepareLearningInput(input) {
  if (input && input.__prepared === true) return input;
  const { glucoseHistory = [], boluses = [], corrections = [], basalDoses = [], activities = {}, macroMealLog = [] } = input || {};
  const glucose = [];
  for (const r of glucoseHistory) {
    const ms = toMs(r.time), value = Number(r.value);
    if (ms != null && r.value != null && !Number.isNaN(value)) glucose.push({ time: ms, ms, value });
  }
  glucose.sort((a, b) => a.ms - b.ms);
  const deduped = [];   // one reading per timestamp (duplicates inflated n and slipped the gap checks)
  for (const r of glucose) if (!deduped.length || deduped[deduped.length - 1].ms !== r.ms) deduped.push(r);
  return {
    __prepared: true,
    glucose: deduped,
    boluses: prepareDoses(boluses),
    corrections: prepareDoses(corrections),
    basal: prepareBasal(basalDoses),
    activities: activities || {},
    macroMeals: prepareMacroMeals(macroMealLog),
  };
}

// Basal records split into <=5-min chunks of signed deviation units
// (delivered - scheduled), clipped to [startMs, endMs). Time not covered
// by any record = the pump ran its schedule = zero deviation.
function basalDeviationChunks(basalDoses, pumpProfile, startMs, endMs) {
  const { list, maxDurMs } = prepareBasal(basalDoses);
  const chunks = [];
  const step = EPISODE_STEP_MIN * 60000;
  for (let i = lowerBoundMs(list, startMs - maxDurMs); i < list.length && list[i].ms < endMs; i++) {
    const { ms: t0, durMs, units } = list[i];
    const t1 = t0 + durMs;
    if (t1 <= startMs) continue;
    const ratePerMs = units / durMs;
    for (let s = t0; s < t1; s += step) {
      const a = Math.max(s, startMs), b = Math.min(t1, s + step, endMs);
      if (b <= a) continue;
      const sched = profileValueAt(pumpProfile, a, 'basalRate');
      chunks.push({ ms: a, units: ratePerMs * (b - a) - (sched == null ? 0 : sched * (b - a) / 3600000) });
    }
  }
  return chunks;
}

// Delivered temp-basal units minus scheduled units over the window
// (+ = Control-IQ gave more than the programmed schedule). Accepts a raw
// basalDoses array or a prepared input / prepared basal index.
function basalDeviationUnits(basalDoses, pumpProfile, startMs, endMs) {
  const src = basalDoses && basalDoses.__prepared ? basalDoses.basal : basalDoses;
  return basalDeviationChunks(src, pumpProfile, toMs(startMs), toMs(endMs)).reduce((s, c) => s + c.units, 0);
}

// Rough Edwards/Banister-style TRIMP from duration and average HR; null without HR.
function workoutTrimp(w, health) {
  const hr = Number(w.avgHr ?? w.averageHeartRate);
  const start = toMs(w.startTime), end = toMs(w.endTime);
  if (!Number.isFinite(hr) || hr <= 0 || start == null || end == null) return null;
  const rest = Number(health?.restingHr) || 60, max = Number(health?.maxHr) || 190;
  const x = clamp((hr - rest) / (max - rest), 0, 1);
  return (end - start) / 60000 * 0.64 * Math.exp(1.92 * x);
}

function exerciseSummary(workouts, fromMs, toMsVal, health) {
  const inWin = (workouts || []).filter(w => {
    const end = toMs(w.endTime) ?? toMs(w.startTime);
    return end != null && end > fromMs && (toMs(w.startTime) ?? end) <= toMsVal;
  });
  const trimps = inWin.map(w => workoutTrimp(w, health)).filter(v => v != null);
  return {
    minutes: inWin.reduce((s, w) => {
      const a = toMs(w.startTime), b = toMs(w.endTime);
      return s + (a != null && b != null ? Math.max(0, (Math.min(b, toMsVal) - Math.max(a, fromMs)) / 60000) : 0);
    }, 0),
    types: [...new Set(inWin.map(w => w.workoutType).filter(Boolean))],
    trimp: trimps.length ? trimps.reduce((s, v) => s + v, 0) : null,
  };
}

function healthValue(health, startMs, key) {
  if (!health) return null;
  const src = typeof health === 'function' ? health(startMs) : health;
  const v = src?.[key];
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

// Snapshot of everything known at an episode's start, for later learning
// to stratify by. Fields the input can't support are null.
// sensorGapMin = longest CGM gap (min) in the 3h before start, incl. up to start.
// `input` may be raw or prepareLearningInput()'d.
function episodeContext(input, startMs, opts = {}) {
  const P = prepareLearningInput(input);
  const { siteChanges = null, health = null } = opts;
  const t = toMs(startMs);
  const lp = londonParts(t);
  const prior = sliceByMs(P.glucose, t - 3 * 3600000, t);
  let start = null;
  for (const r of prior) if (t - r.ms <= 15 * 60000) start = r;
  let gap = prior.length ? (t - prior[prior.length - 1].ms) / 60000 : 180;
  for (let i = 1; i < prior.length; i++) gap = Math.max(gap, (prior[i].ms - prior[i - 1].ms) / 60000);
  let siteAgeHours = null;
  if (Array.isArray(siteChanges)) {
    const last = siteChanges.map(s => toMs(s?.time ?? s)).filter(ms => ms != null && ms <= t).sort((a, b) => b - a)[0];
    if (last != null) siteAgeHours = (t - last) / 3600000;
  }
  const workouts = P.activities?.workouts || [];
  // on board from doses BEFORE the start (the episode's own dose excluded)
  const bolPrior = sliceByMs(P.boluses, t - IOB_DURATION_MINUTES * 60000, t - 1);
  const corrPrior = sliceByMs(P.corrections, t - IOB_DURATION_MINUTES * 60000, t - 1);
  return {
    hour: lp.hour,
    weekend: lp.weekday === 'Sat' || lp.weekday === 'Sun',
    iob: activeInsulin(bolPrior, corrPrior, t),
    cob: carbsOnBoard(sliceByMs(P.boluses, t - COB_DURATION_MINUTES * 60000, t - 1), t),
    startGlucose: start ? start.value : null,
    trendPerMin: computeTrend(sliceByMs(P.glucose, t - TREND_WINDOW_MINUTES * 60000, t), t),
    exercise24h: exerciseSummary(workouts, t - 24 * 3600000, t, health),
    exercise48h: exerciseSummary(workouts, t - 48 * 3600000, t, health),
    siteAgeHours,
    sensorGapMin: gap,
    rhrZ: healthValue(health, t, 'rhrZ'),
    sleepHrs: healthValue(health, t, 'sleepHrs'),
  };
}

// Unlogged food. Two checks, either flags:
//  1. the residual (glucose the fit can't explain) climbs > 2.0 above its
//     own running minimum and stays there >= 30 min;
//  2. a least-squares fit is free to absorb an early snack into a lower
//     isf, hiding (1) — so also refit with a candidate unlogged-carb term
//     (isf * x + k * carbs-absorbed-since-tau, scanned over tau). If the best
//     such term rises > 2.0 above the fit for >= 30 min of the window and
//     explains most of what the plain fit couldn't, the rise is unexplained.
function hasUnexplainedRise(rows) {
  let minRes = 0, aboveSince = null;
  for (const r of rows) {
    if (r.res - minRes > EPISODE_RISE_MMOL) {
      if (aboveSince == null) aboveSince = r.tMin;
      if (r.tMin - aboveSince >= EPISODE_RISE_MIN) return true;
    } else {
      aboveSince = null;
    }
    minRes = Math.min(minRes, r.res);
  }
  if (rows.length < 3) return false;
  const sse0 = rows.reduce((s, r) => s + r.res * r.res, 0);
  const W = rows[rows.length - 1].tMin;
  let best = null;
  for (let tau = 0; tau <= W - EPISODE_RISE_MIN; tau += EPISODE_STEP_MIN) {
    const S = rows.map(r => 1 - cobFraction(r.tMin - tau));
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    rows.forEach((r, i) => { a11 += r.x * r.x; a12 += r.x * S[i]; a22 += S[i] * S[i]; b1 += r.x * r.y; b2 += S[i] * r.y; });
    const det = a11 * a22 - a12 * a12;
    if (!(det > 0)) continue;
    const isf = (b1 * a22 - a12 * b2) / det, k = (a11 * b2 - a12 * b1) / det;
    if (!(k > 0) || !(isf > 0)) continue;
    const sse = rows.reduce((s, r, i) => s + (r.y - isf * r.x - k * S[i]) ** 2, 0);
    if (!best || sse < best.sse) best = { sse, k, S };
  }
  if (!best || !(sse0 > 0) || 1 - best.sse / sse0 < EPISODE_SNACK_MIN_GAIN) return false;
  const firstIdx = best.S.findIndex(s => best.k * s > EPISODE_RISE_MMOL);
  return firstIdx >= 0 && W - rows[firstIdx].tMin >= EPISODE_RISE_MIN;
}

// Residual drop >= 2.0 then recovery >= 1.5 within 45 min — a sensor
// compression artefact, since insulin/carbs (already in the model) don't
// explain it.
function hasCompressionLow(rows) {
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length && rows[j].tMin - rows[i].tMin <= COMPRESSION_WINDOW_MIN; j++) {
      if (rows[i].res - rows[j].res < COMPRESSION_DROP_MMOL) continue;
      for (let k = j + 1; k < rows.length && rows[k].tMin - rows[i].tMin <= COMPRESSION_WINDOW_MIN; k++) {
        if (rows[k].res - rows[j].res >= COMPRESSION_RECOVER_MMOL) return true;
      }
    }
  }
  return false;
}

/* ── Shared episode machinery (corrections + meals) ─────────── */

// Readings after the start, and the starting glucose: the last reading
// within 10 min before the start, else the event's own logged value.
function episodeReadings(P, startMs, endMs, loggedStart) {
  const readings = sliceByMs(P.glucose, startMs - 10 * 60000, endMs);
  const before = readings.filter(r => r.ms <= startMs);
  const after = readings.filter(r => r.ms > startMs);
  const g0 = before.length && startMs - before[before.length - 1].ms <= 10 * 60000
    ? before[before.length - 1].value
    : (loggedStart != null && Number.isFinite(Number(loggedStart)) ? Number(loggedStart) : null);
  return { after, g0 };
}

// Every logged insulin dose absorbing in the window (incl. prior IOB and
// auto-boluses) and every logged carb bolus. The episode's own dose may
// already be in boluses or corrections; it is added once if not.
function episodeDoses(P, startMs, endMs, own = null) {
  const units = Number(own?.units) || 0;
  const lookback = startMs - IOB_DURATION_MINUTES * 60000;
  const bol = sliceByMs(P.boluses, lookback, endMs);
  const corr = sliceByMs(P.corrections, lookback, endMs);
  const included = !own || [...bol, ...corr].some(d => d.ms === startMs && Number(d.units) === units);
  const doses = [...bol, ...corr, ...(included ? [] : [own])];
  const meals = sliceByMs(P.boluses, startMs - COB_DURATION_MINUTES * 60000, endMs).filter(d => (Number(d.carbs) || 0) > 0);
  if (!included && (Number(own?.carbs) || 0) > 0) meals.push({ ...own, time: startMs, ms: startMs });
  return { lookback, doses, meals };
}

// Per reading, what the model says was absorbed between the start and that
// reading (model time CGM_LAG_MINUTES behind the reading): I = insulin units
// from logged doses, B = basal-deviation units, C = logged carb grams.
// win.basalChunks, when given, replaces the basal-deviation chunks (see scaleWindowToMmol).
function episodeTerms(P, pumpProfile, startMs, endMs, after, { lookback, doses, meals, basalChunks: given = null }) {
  const basalChunks = given || basalDeviationChunks(P.basal, pumpProfile, lookback, endMs);
  const lagMs = CGM_LAG_MINUTES * 60000, s0 = startMs - lagMs;
  const chunkStart = basalChunks.map(c => c.units * iobFraction(Math.max(0, (s0 - c.ms) / 60000)));
  const carbs = episodeCarbs(meals, startMs, after);
  return after.map(r => {
    const tEnd = r.ms - lagMs;   // a reading shows glucose from ~lag min earlier
    let B = 0;
    for (let i = 0; i < basalChunks.length; i++) {
      const c = basalChunks[i];
      if (c.ms >= tEnd) continue;
      B += chunkStart[i] - c.units * iobFraction((tEnd - c.ms) / 60000);
    }
    return { ms: r.ms, tMin: (r.ms - startMs) / 60000, value: r.value, I: insulinEffectBetween(doses, [], s0, tEnd), B };
  }).map((t, i) => Object.assign(t, { C: carbs[i] }));
}

// Logged carb grams absorbed between the start and each reading (lagged as
// in episodeTerms). `slow` = { ms, delayMin, durationMin } re-times one meal
// (the episode's own) to start absorbing delayMin late, over durationMin.
function episodeCarbs(meals, startMs, after, slow = null) {
  const lagMs = CGM_LAG_MINUTES * 60000, s0 = startMs - lagMs;
  const own = slow ? meals.filter(m => m.ms === slow.ms).map(m => ({ ...m, time: m.ms + slow.delayMin * 60000 })) : [];
  const rest = slow ? meals.filter(m => m.ms !== slow.ms) : meals;
  return after.map(r => {
    const tEnd = r.ms - lagMs;
    const c = carbEffectBetween(rest, s0, tEnd);
    return slow ? c + carbEffectBetween(own, s0, tEnd, { duration: slow.durationMin }) : c;
  });
}

// Least squares y ~= coef * x through the origin over rows with a finite y;
// sets each row's residual. rmse is over all rows.
function fitThroughOrigin(rows) {
  let sxy = 0, sxx = 0;
  for (const r of rows) if (Number.isFinite(r.y)) { sxy += r.x * r.y; sxx += r.x * r.x; }
  const coef = sxx > 0 ? sxy / sxx : null;
  let sse = 0;
  for (const r of rows) { r.res = coef == null ? NaN : r.y - coef * r.x; if (Number.isFinite(r.res)) sse += r.res * r.res; }
  return { coef, rmse: rows.length && coef != null ? Math.sqrt(sse / rows.length) : null };
}

// Longest CGM gap (min) inside the window, incl. up to its end.
function episodeMaxGap(after, startMs, endMs) {
  let maxGap = 0, prevMs = startMs;
  for (const r of after) { maxGap = Math.max(maxGap, (r.ms - prevMs) / 60000); prevMs = r.ms; }
  return Math.max(maxGap, (endMs - prevMs) / 60000);
}

// The window checks every episode kind shares, in order: missing-profile,
// too-few-readings (< 70% of the expected 5-min readings), sensor-gap
// (a gap > 20 min, no starting glucose, or no fit). null = none apply.
function windowConfounder({ missingProfile, rows, after, startMs, endMs, g0, fitOk = true }) {
  if (missingProfile) return 'missing-profile';
  if (rows.length < EPISODE_MIN_READING_SHARE * Math.floor((endMs - startMs) / 60000 / EPISODE_STEP_MIN)) return 'too-few-readings';
  if (episodeMaxGap(after, startMs, endMs) > EPISODE_MAX_GAP_MIN || g0 == null || !fitOk) return 'sensor-gap';
  return null;
}

// ISF (mmol/L per U) in force at ms: opts.isfAt(ms) when given, else the pump
// correction factor; null when missing or outside the reliable range.
function resolveIsfAt(isfAt, pumpProfile, ms) {
  const v = typeof isfAt === 'function' ? Number(isfAt(ms)) : profileValueAt(pumpProfile, ms, 'correctionFactor');
  return v >= MIN_RELIABLE_FACTOR && v <= MAX_RELIABLE_FACTOR ? v : null;
}

// The window's doses re-expressed in mmol/L: each insulin dose and basal-
// deviation chunk x ISF at its own time, each carb bolus x ISF/CR at its own
// time (a dose acts with the sensitivity of the hour it was given — the
// convention behind scoreCorrectionEpisode's per-hour ISF), so episodeTerms
// then returns I, B, C in mmol/L even when the window crosses profile
// segments (e.g. a whole night). ISF from opts.isfAt, else the pump; CR from
// the pump. null when ISF (checked at startMs too), a needed CR, or the basal
// schedule can't be resolved -> missing-profile.
function scaleWindowToMmol(P, pumpProfile, isfAt, win, startMs, endMs) {
  const isf = ms => resolveIsfAt(isfAt, pumpProfile, ms);
  if (!hasProfileField(pumpProfile, 'basalRate') || isf(startMs) == null) return null;
  const doses = [], meals = [], basalChunks = [];
  for (const d of win.doses) {
    const f = isf(d.ms);
    if (f == null) return null;
    doses.push({ ...d, units: (Number(d.units) || 0) * f });
  }
  for (const m of win.meals) {
    const f = isf(m.ms), cr = profileValueAt(pumpProfile, m.ms, 'carbRatio');
    if (f == null || !(cr > 0)) return null;
    meals.push({ ...m, carbs: (Number(m.carbs) || 0) * f / cr });
  }
  for (const c of basalDeviationChunks(P.basal, pumpProfile, win.lookback, endMs)) {
    const f = isf(c.ms);
    if (f == null) return null;
    basalChunks.push({ ms: c.ms, units: c.units * f });
  }
  return { lookback: win.lookback, doses, meals, basalChunks };
}

// Least squares y ~= a * x + b * x2 (no intercept) over rows with a finite y;
// sets each row's residual. null coefficients when (near-)singular.
function fitTwoThroughOrigin(rows) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0;
  for (const r of rows) if (Number.isFinite(r.y)) { s11 += r.x * r.x; s12 += r.x * r.x2; s22 += r.x2 * r.x2; s1y += r.x * r.y; s2y += r.x2 * r.y; }
  const det = s11 * s22 - s12 * s12;
  const ok = det > 1e-9 * s11 * s22 && det > 0;
  const a = ok ? (s1y * s22 - s12 * s2y) / det : null, b = ok ? (s11 * s2y - s12 * s1y) / det : null;
  let sse = 0;
  for (const r of rows) { r.res = a == null ? NaN : r.y - a * r.x - b * r.x2; if (Number.isFinite(r.res)) sse += r.res * r.res; }
  return { a, b, rmse: rows.length && a != null ? Math.sqrt(sse / rows.length) : null };
}

// Whole-curve fit of one correction. Over the window, glucose change
//   delta(t) ~= isf * (-I(t) - B(t) + C(t)/CR)
// is linear in isf (I: insulin absorbed from ALL logged doses incl. prior
// IOB and auto-boluses, B: basal deviation absorbed, C: logged carbs
// absorbed, CR: pump carb ratio at the start), so least squares is closed
// form. Model time runs CGM_LAG_MINUTES behind each reading.
// No separate starting-trend term m(t): with every logged source modelled,
// the trend at the start is already explained by prior IOB/COB, and
// carrying the noisy 20-min CGM slope forward double-counted it (sim:
// mean ISF error 14% without it vs 21% with it; see task-3 report).
// Without a pump carb ratio + basal schedule the fit can't separate basal
// from correction insulin, so it isn't attempted ('missing-profile').
// A fitted isf outside [MIN_RELIABLE_FACTOR, MAX_RELIABLE_FACTOR] is kept
// for diagnostics but flagged 'implausible-fit'.
// `input` may be raw or prepareLearningInput()'d (prepare once when
// scoring many episodes). Null until the window has fully elapsed.
function scoreCorrectionEpisode(input, correction, opts = {}) {
  const { pumpProfile = null, nowMs = Date.now(), windowMin = 240, siteChanges = null, health = null } = opts;
  const startMs = toMs(correction?.time);
  const units = Number(correction?.units) || 0;
  if (startMs == null || units <= 0) return null;
  const endMs = startMs + windowMin * 60000;
  if (toMs(nowMs) < endMs) return null;

  const P = prepareLearningInput(input);
  const context = episodeContext(P, startMs, { pumpProfile, siteChanges, health });
  const { after, g0 } = episodeReadings(P, startMs, endMs, correction.startGlucose);
  if (context.startGlucose == null) context.startGlucose = g0;

  const cr = profileValueAt(pumpProfile, startMs, 'carbRatio');
  const missingProfile = !(cr > 0) || !hasProfileField(pumpProfile, 'basalRate');
  const win = episodeDoses(P, startMs, endMs, correction);

  let rows = [], isf = null, rmse = null;
  if (!missingProfile) {
    rows = episodeTerms(P, pumpProfile, startMs, endMs, after, win)
      .map(t => ({ tMin: t.tMin, x: -t.I - t.B + t.C / cr, y: g0 == null ? NaN : t.value - g0 }));
    ({ coef: isf, rmse } = fitThroughOrigin(rows));
  }
  const fit = { isf, rmse, n: missingProfile ? after.length : rows.length };

  let confounded = null;
  if (correction.auto) confounded = 'auto-bolus';
  else if ((confounded = windowConfounder({ missingProfile, rows, after, startMs, endMs, g0, fitOk: isf != null }))) { /* labelled */ }
  else if (win.meals.some(b => b.ms >= startMs)) confounded = 'carbs-in-window';
  else if (hasCompressionLow(rows)) confounded = 'compression-low';
  else if (hasUnexplainedRise(rows)) confounded = 'unexplained-rise';
  else if (!(isf >= MIN_RELIABLE_FACTOR && isf <= MAX_RELIABLE_FACTOR)) confounded = 'implausible-fit';

  return { kind: 'correction', startMs, units, context, fit, confounded };
}

const MEAL_CR_MIN_G         = 2;    // g/U: a fitted carb ratio outside [2, 60] is implausible
const MEAL_CR_MAX_G         = 60;
const MEAL_STACK_MIN        = 90;   // another carb bolus this close -> stacked-meal
const MEAL_DELAYED_PEAK_MIN = 150;  // unexplained rise peaking later than this -> delayedRise
const MEAL_MACRO_MATCH_MIN  = 20;   // macroMealLog entry within this of the bolus
const MEAL_LATE_FAT_G       = 20;   // only meals logged with >= 20 g fat can be 'late-absorption'
const MEAL_SLOW_DELAYS_MIN    = [0, 30, 60, 90];        // slow-absorption candidates tried
const MEAL_SLOW_DURATIONS_MIN = [180, 240, 300, 360];
const MEAL_SLOW_RMSE_SHARE  = 0.7;  // slow curve must cut the standard fit's rmse to <= 70%

// Whole-curve fit of one meal bolus, in hindsight. With ISF known
// (opts.isfAt(startMs); falls back to the pump correction factor),
//   delta(t) + isf * (I(t) + B(t)) ~= isf * C(t) * (1/CR)
// is linear in 1/CR, so least squares is closed form (same terms and lag as
// scoreCorrectionEpisode). Every logged carb absorbing in the window (incl.
// an earlier meal's tail) shares the fitted ratio.
// idealUnits = carbs / fitted CR is the dose that would have been right;
// deltaUnits = idealUnits - units. peakMin = minutes to the highest reading.
// delayedRise = glucose rose later than the standard carb curve explains:
// the fit's residual peaks > 2.0 after 150 min, or the episode is
// 'late-absorption'. (Raw peak time isn't used: an under-dosed meal peaks
// late too, without any slow absorption.)
// Confounders as scoreCorrectionEpisode, except carbs in the window are the
// point here: instead 'stacked-meal' when another carb bolus is within 90 min,
// and 'late-absorption' (checked before 'unexplained-rise') when a meal
// logged with >= 20 g fat leaves a late residual rise that a delayed /
// stretched carb curve for that meal explains (fit.slowAbsorption holds the
// best delay/duration). Late-absorption episodes are not clean: their
// standard-curve CR is biased, so CR learning skips them.
// Missing/implausible ISF or no basal schedule -> 'missing-profile';
// a fitted CR <= 0, non-finite or outside [2, 60] g/U -> 'implausible-fit'.
function scoreMealEpisode(input, bolus, opts = {}) {
  const { pumpProfile = null, isfAt = null, nowMs = Date.now(), windowMin = 300, siteChanges = null, health = null } = opts;
  const startMs = toMs(bolus?.time);
  const carbs = Number(bolus?.carbs) || 0;
  const units = Math.max(0, Number(bolus?.units) || 0);
  if (startMs == null || carbs <= 0) return null;
  const endMs = startMs + windowMin * 60000;
  if (toMs(nowMs) < endMs) return null;

  const P = prepareLearningInput(input);
  const context = episodeContext(P, startMs, { pumpProfile, siteChanges, health });
  const { after, g0 } = episodeReadings(P, startMs, endMs, bolus.startGlucose);
  if (context.startGlucose == null) context.startGlucose = g0;

  const isf = resolveIsfAt(isfAt, pumpProfile, startMs);
  const missingProfile = isf == null || !hasProfileField(pumpProfile, 'basalRate');
  const win = episodeDoses(P, startMs, endMs, bolus);

  const toCr = coef => (coef != null && Number.isFinite(1 / coef) ? 1 / coef : null);
  const isPlausible = cr => cr != null && cr >= MEAL_CR_MIN_G && cr <= MEAL_CR_MAX_G;
  let rows = [], carbRatio = null, rmse = null;
  if (!missingProfile) {
    rows = episodeTerms(P, pumpProfile, startMs, endMs, after, win)
      .map(t => ({ tMin: t.tMin, x: isf * t.C, y: g0 == null ? NaN : t.value - g0 + isf * (t.I + t.B) }));
    const f = fitThroughOrigin(rows);
    rmse = f.rmse;
    carbRatio = toCr(f.coef);
  }
  const plausible = isPlausible(carbRatio);
  const idealUnits = carbRatio > 0 ? carbs / carbRatio : null;

  let peakMin = null, peak = -Infinity;
  for (const r of after) if (r.value > peak) { peak = r.value; peakMin = (r.ms - startMs) / 60000; }

  let macros = null, bestDt = Infinity;
  for (const m of sliceByMs(P.macroMeals || [], startMs - MEAL_MACRO_MATCH_MIN * 60000, startMs + MEAL_MACRO_MATCH_MIN * 60000)) {
    const dt = Math.abs(m.ms - startMs);
    if (dt < bestDt) { bestDt = dt; macros = { fat: m.fat, protein: m.protein }; }
  }

  // late residual rise: the standard curve leaves glucose > 2.0 above the fit, peaking after 150 min
  let resPeak = -Infinity, resPeakMin = null;
  for (const r of rows) if (Number.isFinite(r.res) && r.res > resPeak) { resPeak = r.res; resPeakMin = r.tMin; }
  const lateResidual = resPeak > EPISODE_RISE_MMOL && resPeakMin > MEAL_DELAYED_PEAK_MIN;

  // high-fat meal with a late rise: does a delayed/stretched curve for this meal explain it?
  let slowAbsorption = null;
  if (lateResidual && rmse > 0 && (macros?.fat ?? 0) >= MEAL_LATE_FAT_G) {
    const own = win.meals.find(m => m.ms === startMs);
    let best = null;
    for (const delayMin of MEAL_SLOW_DELAYS_MIN) for (const durationMin of MEAL_SLOW_DURATIONS_MIN) {
      if (!own || (delayMin === 0 && durationMin === COB_DURATION_MINUTES)) continue;
      const C = episodeCarbs(win.meals, startMs, after, { ms: startMs, delayMin, durationMin });
      const alt = rows.map((r, i) => ({ tMin: r.tMin, x: isf * C[i], y: r.y }));
      const f = fitThroughOrigin(alt);
      if (f.rmse != null && (!best || f.rmse < best.rmse)) best = { delayMin, durationMin, rmse: f.rmse, carbRatio: toCr(f.coef), rows: alt };
    }
    if (best && best.rmse <= MEAL_SLOW_RMSE_SHARE * rmse && isPlausible(best.carbRatio) && !hasUnexplainedRise(best.rows)) {
      slowAbsorption = { delayMin: best.delayMin, durationMin: best.durationMin, carbRatio: best.carbRatio, rmse: best.rmse };
    }
  }

  const stacked = sliceByMs(P.boluses, startMs - MEAL_STACK_MIN * 60000, startMs + MEAL_STACK_MIN * 60000)
    .some(d => d.ms !== startMs && (Number(d.carbs) || 0) > 0);
  let confounded = null;
  if (bolus.auto) confounded = 'auto-bolus';
  else if ((confounded = windowConfounder({ missingProfile, rows, after, startMs, endMs, g0 }))) { /* labelled */ }
  else if (stacked) confounded = 'stacked-meal';
  else if (hasCompressionLow(rows)) confounded = 'compression-low';
  else if (slowAbsorption) confounded = 'late-absorption';
  else if (hasUnexplainedRise(rows)) confounded = 'unexplained-rise';
  else if (!plausible) confounded = 'implausible-fit';

  return {
    kind: 'meal', startMs, carbs, units, context,
    fit: { carbRatio, rmse, n: missingProfile ? after.length : rows.length, peakMin, idealUnits, slowAbsorption },
    deltaUnits: idealUnits == null ? null : idealUnits - units,
    macros, delayedRise: confounded === 'late-absorption' || lateResidual,
    confounded,
  };
}

const EXERCISE_AFTER_MIN        = 60;    // exercise window runs to workout end + 60 min
const EXERCISE_MAX_DROP_PER_MIN = 0.3;   // |dropPerMin| above this (mmol/L per min) is implausible
const NIGHT_START_HOUR          = 0;     // London 00:00-06:00
const NIGHT_END_HOUR            = 6;
const NIGHT_ISF_RATIO_MIN       = 0.3;   // night sensitivity multiplier outside [0.3, 3] is implausible
const NIGHT_ISF_RATIO_MAX       = 3;
const NIGHT_MIN_INSULIN_MMOL    = 1.0;   // logged insulin moving glucose < 1 mmol/L all night -> ratio undetermined

// Shared start of an exercise / night window: readings, every logged dose
// and carb absorbing in it, and per reading the modelled effects in mmol/L
// (terms: I insulin, B basal deviation, C carbs; null -> missing-profile).
function windowModel(P, pumpProfile, isfAt, startMs, endMs) {
  const { after, g0 } = episodeReadings(P, startMs, endMs, null);
  const win = episodeDoses(P, startMs, endMs);
  const scaled = scaleWindowToMmol(P, pumpProfile, isfAt, win, startMs, endMs);
  return { after, g0, win, terms: scaled && episodeTerms(P, pumpProfile, startMs, endMs, after, scaled) };
}

// The confounders exercise and night windows share after the window checks:
// carbs-in-window (logged carbs eaten in the window: their effect rests on
// the pump CR guess, which would leak into the fit), compression-low,
// unexplained-rise, then implausible-fit when !plausible.
function windowEventConfounder(rows, win, startMs, plausible) {
  if (win.meals.some(b => b.ms >= startMs)) return 'carbs-in-window';
  if (hasCompressionLow(rows)) return 'compression-low';
  if (hasUnexplainedRise(rows)) return 'unexplained-rise';
  return plausible ? null : 'implausible-fit';
}

// One workout, scored once workout end + 60 min has passed. The residual
// glucose change after modelling every logged insulin dose (incl. auto-
// boluses and prior IOB), basal deviation and logged carbs, at ISF from
// opts.isfAt (else the pump correction factor) and the pump carb ratio:
//   residual(t) ~= -dropPerMin * (exercise minutes elapsed by model time t)
// fitted through the origin, so dropPerMin is mmol/L per exercise minute
// (positive = drop), and the end..end+60 tail confirms the drop stopped with
// the workout. Model time lags readings by CGM_LAG_MINUTES.
// Confounders: missing-profile, too-few-readings, sensor-gap, carbs-in-window,
// compression-low, unexplained-rise, implausible-fit (|dropPerMin| > 0.3 or
// non-finite).
function scoreExerciseEpisode(input, workout, opts = {}) {
  const { pumpProfile = null, isfAt = null, nowMs = Date.now(), siteChanges = null, health = null } = opts;
  const startMs = toMs(workout?.startTime), workEnd = toMs(workout?.endTime);
  if (startMs == null || workEnd == null || !(workEnd > startMs)) return null;
  const endMs = workEnd + EXERCISE_AFTER_MIN * 60000;
  if (toMs(nowMs) < endMs) return null;
  const minutes = (workEnd - startMs) / 60000;

  const P = prepareLearningInput(input);
  const context = episodeContext(P, startMs, { pumpProfile, siteChanges, health });
  const { after, g0, win, terms } = windowModel(P, pumpProfile, isfAt, startMs, endMs);
  if (context.startGlucose == null) context.startGlucose = g0;
  const missingProfile = terms == null;

  let rows = [], dropPerMin = null, rmse = null;
  if (!missingProfile) {
    const lagMs = CGM_LAG_MINUTES * 60000;
    rows = terms.map(t => ({ tMin: t.tMin,
      x: -clamp((t.ms - lagMs - startMs) / 60000, 0, minutes),
      y: g0 == null ? NaN : t.value - g0 + t.I + t.B - t.C }));
    ({ coef: dropPerMin, rmse } = fitThroughOrigin(rows));
  }

  const confounded = windowConfounder({ missingProfile, rows, after, startMs, endMs, g0, fitOk: dropPerMin != null })
    || windowEventConfounder(rows, win, startMs, Math.abs(dropPerMin) <= EXERCISE_MAX_DROP_PER_MIN);

  return {
    kind: 'exercise', startMs, endMs, workoutType: workout.workoutType ?? null, minutes,
    intensity: classifyIntensity(workout.workoutType), context,
    fit: { dropPerMin, rmse, n: missingProfile ? after.length : rows.length },
    confounded,
  };
}

// One night: London 00:00-06:00 on the London date containing nightStartMs
// (5 or 7 hours on a clock-change night), scored once 06:00 has passed.
// With every logged insulin / basal-deviation / carb effect modelled at the
// expected ISF (opts.isfAt, else pump) and the pump carb ratio:
//   g(t) - g0 - carbs(t) ~= -isfRatio * insulin(t) + driftPerHr * hours(t)
// isfRatio = the night's best-fit ISF / expected ISF (> 1 = more sensitive,
// e.g. after exercise); driftPerHr = change the logged inputs don't explain
// (basal schedule too low/high, dawn phenomenon). Confounders as
// scoreExerciseEpisode, plus 'weak-signal' (checked after the window checks)
// when the logged insulin would move glucose < 1 mmol/L all night, so the
// ratio is undetermined (fit.insulinMmol); implausible-fit = isfRatio outside
// [0.3, 3] or a non-finite drift. context (at 00:00) carries exercise24h / exercise48h.
function scoreNight(input, nightStartMs, opts = {}) {
  const { pumpProfile = null, isfAt = null, nowMs = Date.now(), siteChanges = null, health = null } = opts;
  const t = toMs(nightStartMs);
  if (t == null) return null;
  const startMs = londonClockMs(t, NIGHT_START_HOUR), endMs = londonClockMs(t, NIGHT_END_HOUR);
  if (toMs(nowMs) < endMs) return null;

  const P = prepareLearningInput(input);
  const context = episodeContext(P, startMs, { pumpProfile, siteChanges, health });
  const { after, g0, win, terms } = windowModel(P, pumpProfile, isfAt, startMs, endMs);
  if (context.startGlucose == null) context.startGlucose = g0;
  const missingProfile = terms == null;

  let rows = [], isfRatio = null, driftPerHr = null, rmse = null, insulinMmol = null;
  if (!missingProfile) {
    rows = terms.map(t => ({ tMin: t.tMin, x: -t.I - t.B, x2: t.tMin / 60,
      y: g0 == null ? NaN : t.value - g0 - t.C }));
    ({ a: isfRatio, b: driftPerHr, rmse } = fitTwoThroughOrigin(rows));
    insulinMmol = Math.max(0, ...rows.map(r => Math.abs(r.x)));
    for (const r of rows) r.y -= (driftPerHr ?? 0) * r.x2;   // rise checks see the drift-corrected curve
  }

  // no fit because there was no insulin to fit is weak-signal, not a sensor problem
  const weak = insulinMmol != null && insulinMmol < NIGHT_MIN_INSULIN_MMOL;
  const confounded = windowConfounder({ missingProfile, rows, after, startMs, endMs, g0, fitOk: isfRatio != null || weak })
    || (weak ? 'weak-signal' : null)
    || windowEventConfounder(rows, win, startMs,
      isfRatio >= NIGHT_ISF_RATIO_MIN && isfRatio <= NIGHT_ISF_RATIO_MAX && Number.isFinite(driftPerHr));

  return {
    kind: 'night', startMs, endMs, context,
    fit: { isfRatio, driftPerHr, rmse, n: missingProfile ? after.length : rows.length, insulinMmol },
    confounded,
  };
}

/* ── fitModel: episodes -> the learned model ──────────────────────
   The model drives dose SUGGESTIONS, so its safety rules are binding:
   only clean (confounded === null) episodes count; evidence for MORE
   insulin (ISF or CR below pump) needs n >= 10, for less n >= 5; every
   value stays inside pump x [0.7, 1.3]; a value moves at most 10% per
   day since the previous model; exercise effects can only ever predict
   lower glucose / more sensitivity. Pure, deterministic, JSON-safe. */
const MODEL_VERSION           = 2;
const MODEL_N_LESS_INSULIN    = 5;
const MODEL_N_MORE_INSULIN    = 10;
const MODEL_BAND_LO           = 0.7;
const MODEL_BAND_HI           = 1.3;
const MODEL_RATE_PER_DAY      = 0.10;
const MODEL_EXERCISE_MIN_N    = 3;
const MODEL_BOOST_MIN_NIGHTS  = 5;
const MODEL_BOOST_HOURS       = 24;
const MODEL_BOOST_NORMALISE_MAX = 1.3;   // post-exercise ISF/CR are divided by at most this
const MODEL_MODIFIER_MIN_N    = 10;
const MODEL_SITE_AGE_HOURS    = 48;
const MODEL_ILLNESS_RHR_Z     = 1.5;
const MODEL_SHORT_SLEEP_HRS   = 6;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Weighted mean, n (episode count), weight sum and SE (weighted sd / sqrt(effective n)).
function weightedStats(items) {
  const n = items.length;
  const sw = items.reduce((s, x) => s + x.w, 0);
  if (!n || !(sw > 0)) return { n, sw: 0, mean: null, se: null };
  const m = items.reduce((s, x) => s + x.w * x.v, 0) / sw;
  const sw2 = items.reduce((s, x) => s + x.w * x.w, 0);
  const nEff = sw * sw / sw2;
  const variance = items.reduce((s, x) => s + x.w * (x.v - m) ** 2, 0) / sw;
  return { n, sw, mean: m, se: n >= 2 && nEff > 1 ? Math.sqrt(variance * nEff / (nEff - 1) / nEff) : null };
}

// One block parameter (ISF or CR — for both, a higher value = less insulin).
// Shrinkage weighs the block by sum w (recency-weighted) by design; the asymmetry thresholds
// count raw clean episodes (n).
// Rate limit, in ratio-to-pump space (a pump-setting change doesn't drag the value back): only
// moves toward MORE insulin than both the previous model and the pump are slowed, to 10%/day
// below min(prev ratio, 1). Moves toward the pump or toward less insulin apply immediately.
function fitBlockParam(items, all, pump, prev, daysSincePrev, shrinkK) {
  const b = weightedStats(items);
  const out = { value: pump, pump, n: b.n, nPostExercise: items.filter(x => x.post).length, source: 'pump',
    outsideBand: false, rateLimited: false, se: b.se };
  if (!isNum(pump) || !(pump > 0)) return { ...out, value: null, pump: null };
  const usable = (value, n) => isNum(value) && n >= (value > pump ? MODEL_N_LESS_INSULIN : MODEL_N_MORE_INSULIN);
  let value = null;
  if (b.mean != null && all.mean != null) {
    const shrunk = (b.sw * b.mean + shrinkK * all.mean) / (b.sw + shrinkK);
    if (usable(shrunk, b.n)) { value = shrunk; out.source = 'learned'; }
  }
  if (value == null && usable(all.mean, all.n)) { value = all.mean; out.source = 'pooled'; }
  if (value == null) value = pump;
  const lo = pump * MODEL_BAND_LO, hi = pump * MODEL_BAND_HI;
  if (value < lo || value > hi) { out.outsideBand = true; value = clamp(value, lo, hi); }
  const prevRatio = isNum(prev?.value) && isNum(prev?.pump) && prev.pump > 0 && prev.value > 0 ? prev.value / prev.pump : null;
  if (prevRatio != null && isNum(daysSincePrev)) {
    const floor = Math.min(prevRatio, 1) * (1 - MODEL_RATE_PER_DAY * Math.max(0, daysSincePrev));
    if (value / pump < floor) { value = floor * pump; out.rateLimited = true; }
    if (value < lo || value > hi) { out.outsideBand = true; value = clamp(value, lo, hi); }
  }
  out.value = value;
  return out;
}

// Condition modifier: correction ISF (relative to the pump ISF at the
// episode's start) with vs without the condition. Active only with >= 10
// each side and |diff| > 2 SE; effect = mean ratio with / without.
function fitModifier(isfItems, pumpProfile, cond) {
  const w = [], wo = [];
  for (const { ep, v } of isfItems) {
    const c = cond(ep.context || {});
    if (c == null) continue;
    const pump = profileValueAt(pumpProfile, ep.startMs, 'correctionFactor');
    const rel = pump > 0 ? v / pump : v;
    (c ? w : wo).push(rel);
  }
  const off = { active: false, effect: 1, n: w.length, nWithout: wo.length };
  if (w.length < MODEL_MODIFIER_MIN_N || wo.length < MODEL_MODIFIER_MIN_N) return off;
  const mW = mean(w), mO = mean(wo);
  const sampleVar = (xs, m) => xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  const se = Math.sqrt(sampleVar(w, mW) / w.length + sampleVar(wo, mO) / wo.length);
  if (!(mO > 0) || !(Math.abs(mW - mO) > 2 * se)) return off;
  return { active: true, effect: mW / mO, n: w.length, nWithout: wo.length };
}

const finiteOrNull = v => (isNum(v) ? v : null);

// episodes: from scoreCorrectionEpisode / scoreMealEpisode / scoreExerciseEpisode / scoreNight.
// ISF per block from clean corrections (fit.isf), CR from clean meals (fit.carbRatio), bucketed by
// the London hour of the episode start; weights 0.5^(age / halfLifeDays); block value shrunk toward
// the all-day mean by its weight sum: (sum w * blockMean + k * allDay) / (sum w + k).
// Without a pump profile there is no band to guard with, so values are null (source 'pump').
function fitModel(episodes, pumpProfile, opts = {}) {
  const { nowMs: nowIn = Date.now(), prevModel: prevIn = null, halfLifeDays = 30, shrinkK = 5 } = opts;
  const prevModel = asModel(prevIn);   // a malformed previous model counts as none
  const nowMs = toMs(nowIn);
  const clean = (episodes || []).filter(ep => ep && ep.confounded === null && isNum(toMs(ep.startMs)));
  const weight = ep => 0.5 ** (Math.max(0, nowMs - toMs(ep.startMs)) / DAY_MS / halfLifeDays);
  // > 0 workout minutes in the 24h before the start = inside the post-exercise boost window
  const exercised = ep => (Number(ep.context?.exercise24h?.minutes) || 0) > 0;

  // exercise: per workout type, median of clean episodes (one unlogged snack can't swing it),
  // never a rise
  const exercise = {};
  const byType = new Map();
  for (const ep of clean) {
    if (ep.kind !== 'exercise' || !ep.workoutType || !isNum(ep.fit?.dropPerMin)) continue;
    if (!byType.has(ep.workoutType)) byType.set(ep.workoutType, []);
    byType.get(ep.workoutType).push(ep.fit.dropPerMin);
  }
  for (const type of [...byType.keys()].sort()) {
    const v = byType.get(type);
    if (v.length >= MODEL_EXERCISE_MIN_N) exercise[type] = { dropPerMin: Math.max(0, median(v)), n: v.length };
  }
  // post-exercise boost: median night isfRatio with a workout in the 24h before 00:00 / without
  const nights = clean.filter(ep => ep.kind === 'night' && isNum(ep.fit?.isfRatio));
  const after = nights.filter(exercised).map(ep => ep.fit.isfRatio);
  const without = nights.filter(ep => !exercised(ep)).map(ep => ep.fit.isfRatio);
  const boostOk = after.length >= MODEL_BOOST_MIN_NIGHTS && without.length >= MODEL_BOOST_MIN_NIGHTS && median(without) > 0;
  exercise.boost = { multiplier: boostOk ? Math.max(1, median(after) / median(without)) : 1,
    n: after.length, nWithout: without.length, hours: MODEL_BOOST_HOURS };

  // Post-exercise episodes (inside boost.hours of a workout) carry the boost. When the boost is
  // learned, divide it (capped at 1.3, so normalising can't raise baseline doses much) out of their
  // fitted ISF / CR (applyModel multiplies the boost back in) and keep
  // them: someone who trains most days has few episodes outside the window. When it isn't learned
  // (multiplier 1), they go in as-is — that is the person's habitual state.
  const norm = Math.min(exercise.boost.multiplier, MODEL_BOOST_NORMALISE_MAX);
  const items = (kind, get) => clean.filter(ep => ep.kind === kind && isNum(get(ep)) && get(ep) > 0)
    .map(ep => {
      const post = exercised(ep);
      return { ep, post, v: post ? get(ep) / norm : get(ep),
        w: weight(ep), hour: hourOfDay(toMs(ep.startMs)) };
    });
  const isfItems = items('correction', ep => ep.fit?.isf);
  const crItems = items('meal', ep => ep.fit?.carbRatio);
  const allIsf = weightedStats(isfItems), allCr = weightedStats(crItems);

  const table = prescribedRegimenTable(pumpProfile) || REGIMEN_TOD_BUCKETS.map(() => ({}));
  const prevFitted = prevModel ? toMs(prevModel.fittedAt) : null;
  const daysSincePrev = prevFitted != null ? (nowMs - prevFitted) / DAY_MS : null;
  const blocks = REGIMEN_TOD_BUCKETS.map((bk, i) => {
    const prev = prevModel?.blocks.find(b => b.label === bk.label);
    const inBlock = xs => xs.filter(x => x.hour >= bk.from && x.hour < bk.to);
    return {
      label: bk.label, from: bk.from, to: bk.to,
      isf: fitBlockParam(inBlock(isfItems), allIsf, finiteOrNull(table[i].correctionFactor), prev?.isf, daysSincePrev, shrinkK),
      carbRatio: fitBlockParam(inBlock(crItems), allCr, finiteOrNull(table[i].carbRatio), prev?.carbRatio, daysSincePrev, shrinkK),
    };
  });

  const modifiers = {
    siteAge: fitModifier(isfItems, pumpProfile, c => (isNum(c.siteAgeHours) ? c.siteAgeHours >= MODEL_SITE_AGE_HOURS : null)),
    illness: fitModifier(isfItems, pumpProfile, c => (isNum(c.rhrZ) ? c.rhrZ >= MODEL_ILLNESS_RHR_Z : null)),
    shortSleep: fitModifier(isfItems, pumpProfile, c => (isNum(c.sleepHrs) ? c.sleepHrs < MODEL_SHORT_SLEEP_HRS : null)),
  };

  // delayed rise: meals that are clean or late-absorption (other labels can't tell a late rise
  // from a snack); high fat = logged fat >= 20 g, other = logged fat < 20 g or no macro log
  const riseMeals = (episodes || []).filter(ep => ep && ep.kind === 'meal' && (ep.confounded === null || ep.confounded === 'late-absorption'));
  const rate = xs => ({ rate: xs.length ? xs.filter(ep => ep.delayedRise === true).length / xs.length : null, n: xs.length });
  const highFat = ep => isNum(ep.macros?.fat) && ep.macros.fat >= MEAL_LATE_FAT_G;

  return {
    version: MODEL_VERSION,
    fittedAt: nowMs,
    blocks,
    allDay: { isf: allIsf.mean, carbRatio: allCr.mean, nIsf: allIsf.n, nCr: allCr.n },
    exercise,
    modifiers,
    meals: { delayedRiseHighFat: rate(riseMeals.filter(highFat)), delayedRiseOther: rate(riseMeals.filter(ep => !highFat(ep))) },
    forecastBias: [],
  };
}

/* ── Using the model ──────────────────────────────────────────
   applyModel turns a fitted model into the numbers a dose uses right
   now. Safety: a model older than 48h (or none) is ignored (null → the
   callers fall back to the pump settings); the post-exercise boost can
   only ever mean LESS insulin (>= 1, capped at 1.3) and only within its
   hours of a real (> 0 min) workout; modifiers count only when active
   and their condition holds now; the final ISF / CR are re-clamped to the
   ±30% band around the block's pump value. */
const MODEL_FRESH_MS          = 48 * 3600000;
const MODEL_BOOST_APPLY_MAX   = 1.3;
const MODEL_FORECAST_BIAS_MAX = 1.0;   // mmol/L
const MODEL_FUTURE_FIT_MS     = 3600000;   // fittedAt may be at most 1h ahead of now
const MODEL_FORECAST_BIAS_MIN_N = 10;  // a block's bias needs this many scored forecasts
const MODEL_LATE_RISE_RATE    = 0.5;
const MODEL_LATE_RISE_MIN_N   = 5;

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

// A model as stored can be anything (a hand edit, an old row, a bad write).
// Anything malformed is treated as absent: no blocks array → no model;
// non-object exercise / modifiers / meals / allDay → {}; non-array
// forecastBias → []. Callers never throw on a bad model — they fall back.
function asModel(model) {
  if (!isObj(model) || !Array.isArray(model.blocks)) return null;
  return {
    ...model,
    blocks: model.blocks.filter(b => isObj(b) && isNum(b.from) && isNum(b.to)),
    exercise: isObj(model.exercise) ? model.exercise : {},
    modifiers: isObj(model.modifiers) ? model.modifiers : {},
    meals: isObj(model.meals) ? model.meals : {},
    allDay: isObj(model.allDay) ? model.allDay : {},
    forecastBias: Array.isArray(model.forecastBias) ? model.forecastBias.filter(b => isObj(b) && isNum(b.from) && isNum(b.to)) : [],
  };
}

// Fresh = fitted within the last 48h and not more than 1h in the future
// (a future-dated model is a clock or write error). allowFutureFit is only
// for replaying past forecasts against today's model (forecastAccuracyByBlock).
function modelFresh(model, nowMs, { allowFutureFit = false } = {}) {
  const m = asModel(model);
  const fitted = toMs(m?.fittedAt);
  const now = toMs(nowMs);
  if (!m || fitted == null || now == null) return false;
  if (now - fitted > MODEL_FRESH_MS) return false;
  return allowFutureFit || fitted <= now + MODEL_FUTURE_FIT_MS;
}

function modelBlockAt(model, atMs) {
  const h = londonParts(toMs(atMs)).hour;
  return (model?.blocks || []).find(b => h >= b.from && h < b.to) || null;
}

function workoutMinutes(w) {
  const a = toMs(w?.startTime), b = toMs(w?.endTime);
  if (a != null && b != null) return Math.max(0, (b - a) / 60000);
  return Number(w?.minutes) || 0;
}

const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pctText = m => `${m >= 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;

// Sources per parameter: 'learned' / 'pooled' (from the person's data), 'pump' (the block's
// pump value as-is) or 'pump-adjusted' (pump value x boost/modifiers — nothing learned for
// this block, so its sample size is 0). `adjustments` = short names of what was applied.
function applyModel(rawModel, atMs, opts = {}) {
  const { workouts = [], siteAgeHours = null, rhrZ = null, sleepHrs = null, allowFutureFit = false } = opts;
  const at = toMs(atMs);
  const nowMs = toMs(opts.nowMs ?? at);
  if (at == null || !modelFresh(rawModel, nowMs, { allowFutureFit })) return null;
  const model = asModel(rawModel);
  const block = modelBlockAt(model, at);
  if (!block) return null;
  const reasons = [], adjustments = [];
  const workoutList = (Array.isArray(workouts) ? workouts : []).filter(isObj);

  // post-exercise boost: >= 1 always, capped, only after a real workout that ended within boost.hours
  const boost = isObj(model.exercise.boost) ? model.exercise.boost : {};
  const hours = isNum(boost.hours) ? boost.hours : MODEL_BOOST_HOURS;
  const recent = workoutList
    .map(w => ({ w, end: toMs(w.endTime) ?? toMs(w.startTime) }))
    .filter(({ w, end }) => end != null && end <= nowMs && nowMs - end <= hours * 3600000 && workoutMinutes(w) > 0)
    .sort((a, b) => b.end - a.end)[0];
  const boostMult = isNum(boost.multiplier) ? clamp(boost.multiplier, 1, MODEL_BOOST_APPLY_MAX) : 1;
  let multiplier = 1;
  if (recent && boostMult > 1) {
    multiplier *= boostMult;
    const day = _londonDateFmt.format(new Date(recent.end)) === _londonDateFmt.format(new Date(nowMs)) ? 'today' : 'yesterday';
    const what = `${day}'s ${recent.w.workoutType || 'workout'}`;
    reasons.push(`${pctText(boostMult)} after ${what}`);
    adjustments.push(what);
  }

  const mods = model.modifiers;
  const conds = [
    ['siteAge', isNum(siteAgeHours) && siteAgeHours >= MODEL_SITE_AGE_HOURS, `infusion site ${Math.round(siteAgeHours)}h old`, `a ${Math.round(siteAgeHours)}h-old site`],
    ['illness', isNum(rhrZ) && rhrZ >= MODEL_ILLNESS_RHR_Z, 'resting heart rate raised', 'a raised resting heart rate'],
    ['shortSleep', isNum(sleepHrs) && sleepHrs < MODEL_SHORT_SLEEP_HRS, 'short sleep', 'short sleep'],
  ];
  for (const [key, holds, why, short] of conds) {
    const m = mods[key];
    if (!holds || !isObj(m) || m.active !== true || !isNum(m.effect) || !(m.effect > 0)) continue;
    multiplier *= m.effect;
    reasons.push(`${why}: sensitivity ${pctText(m.effect)} (${m.n} corrections)`);
    adjustments.push(short);
  }

  const use = (p, name, unit, out) => {
    if (!isObj(p) || !isNum(p.value) || !isNum(p.pump) || !(p.pump > 0)) return { value: null, source: null, n: 0 };
    const raw = p.value * multiplier;
    const value = clamp(raw, p.pump * MODEL_BAND_LO, p.pump * MODEL_BAND_HI);
    let source, n = 0;
    if (p.source === 'learned') {
      source = 'learned'; n = p.n;
      out.push(`${name} ${fmt1(p.value)} at this time of day (${n} ${unit})`);
    } else if (p.source === 'pooled') {
      source = 'pooled'; n = (unit === 'corrections' ? model.allDay.nIsf : model.allDay.nCr) ?? p.n;
      out.push(`${name} ${fmt1(p.value)} from all your ${unit} across the day (${n})`);
    } else {
      source = multiplier !== 1 ? 'pump-adjusted' : 'pump';
      out.push(multiplier !== 1
        ? `${name} ${fmt1(p.value)} from your pump setting, adjusted for ${adjustments.join(' and ')}`
        : `${name} ${fmt1(p.value)} from your pump setting`);
    }
    if (p.rateLimited) out.push('learned value held back while it settles');
    if (p.outsideBand) out.push('your data suggests outside ±30% of your pump setting — worth discussing');
    if (value !== raw) out.push(`${name} held within ±30% of your pump setting`);
    return { value, source, n: isNum(n) ? n : 0 };
  };
  const isfReasons = [], crReasons = [];
  const isf = use(block.isf, 'sensitivity', 'corrections', isfReasons);
  const cr = use(block.carbRatio, 'carb ratio', 'meals', crReasons);

  // in-progress workout of a learned type: its learned drop rate
  const learnedType = t => t !== 'boost' && isObj(model.exercise[t]) && isNum(model.exercise[t].dropPerMin);
  const ongoing = workoutList.find(w => {
    const a = toMs(w.startTime), b = toMs(w.endTime);
    return a != null && b != null && a <= nowMs && nowMs < b && learnedType(w.workoutType);
  });
  const exerciseDropPerMin = ongoing ? Math.max(0, model.exercise[ongoing.workoutType].dropPerMin) : 0;

  return {
    isf: isf.value, carbRatio: cr.value, isfSource: isf.source, crSource: cr.source,
    sampleSize: isf.n, crSampleSize: cr.n, multiplier, adjustments,
    exerciseDropPerMin,
    exerciseOngoing: ongoing ? { workoutType: ongoing.workoutType, endMs: toMs(ongoing.endTime), n: model.exercise[ongoing.workoutType].n } : null,
    rateLimited: !!block.isf?.rateLimited, outsideBand: !!block.isf?.outsideBand,
    crRateLimited: !!block.carbRatio?.rateLimited, crOutsideBand: !!block.carbRatio?.outsideBand,
    block: { label: block.label, from: block.from, to: block.to },
    // reasons: everything; isfReasons / crReasons: what a correction / a meal dose used
    reasons: [...reasons, ...isfReasons, ...crReasons],
    isfReasons: [...reasons, ...isfReasons],
    crReasons: [...reasons, ...crReasons],
  };
}

// The dose-facing label for a parameter source: learned/pooled → 'learned',
// pump x adjustments → 'pump-adjusted', the plain pump value → 'pump-setting'.
function doseSource(paramSource) {
  if (paramSource === 'learned' || paramSource === 'pooled') return 'learned';
  if (paramSource === 'pump-adjusted') return 'pump-adjusted';
  return 'pump-setting';
}

// The current block's learned forecast bias (predicted − actual), capped ±1.0 mmol/L;
// null with fewer than MODEL_FORECAST_BIAS_MIN_N scored forecasts.
function modelForecastBias(rawModel, atMs) {
  const model = asModel(rawModel);
  if (!model) return null;
  const h = londonParts(toMs(atMs)).hour;
  const row = model.forecastBias.find(b => h >= b.from && h < b.to);
  if (!row || !isNum(row.bias) || !((row.n || 0) >= MODEL_FORECAST_BIAS_MIN_N)) return null;
  return { bias: clamp(row.bias, -MODEL_FORECAST_BIAS_MAX, MODEL_FORECAST_BIAS_MAX), n: row.n };
}

// The learned model's extra forecast terms at t minutes ahead — shared by
// computeForecastCore (t = the 2h horizon) and projectedGlucoseCurve (each
// step) so the chart and the alert agree. An in-progress workout of a
// learned type drops at its learned rate for min(t, time left in it); the
// block's forecast bias is a 2h bias, so it ramps in linearly to full at 2h,
// and only ever lowers the forecast.
function modelForecastTerms(applied, model, nowMs, t) {
  const out = { liveExerciseDropMmol: 0, forecastBiasShift: 0, reasons: [] };
  if (!applied) return out;
  if (applied.exerciseOngoing && applied.exerciseDropPerMin > 0) {
    const remainingMin = clamp((applied.exerciseOngoing.endMs - nowMs) / 60000, 0, t);
    out.liveExerciseDropMmol = applied.exerciseDropPerMin * remainingMin;
    out.reasons.push(`${applied.exerciseOngoing.workoutType} in progress: about ${fmt1(out.liveExerciseDropMmol)} mmol/L more drop before it ends (${applied.exerciseOngoing.n} sessions)`);
  }
  // Only ever LOWERS the forecast (a forecast that has run high): raising it
  // would mean more insulin on the high side and fewer low alerts.
  const bias = modelForecastBias(model, nowMs);
  if (bias && bias.bias > 0) {
    out.forecastBiasShift = -bias.bias * clamp(t / HYPO_FORECAST_HORIZON_MIN, 0, 1);
    out.reasons.push(`forecast lowered ${fmt1(bias.bias)} mmol/L — at this time of day it has run high (${bias.n} checks)`);
  }
  return out;
}

// What applyModel needs from an engine input, beyond the model itself.
// input.modelContext (optional): { siteAgeHours, rhrZ, sleepHrs } for the modifiers.
function modelOpts(input, now) {
  const c = isObj(input?.modelContext) ? input.modelContext : {};
  const w = input?.activities?.workouts;
  return { model: input?.model, atMs: now, workouts: Array.isArray(w) ? w : [],
    siteAgeHours: c.siteAgeHours ?? null, rhrZ: c.rhrZ ?? null, sleepHrs: c.sleepHrs ?? null,
    allowFutureFit: input?.modelReplay === true };
}

// The learned carb ratio for this time of day, or null (no fresh model).
function modelCarbRatio(input, now) {
  const o = modelOpts(input, now);
  const a = o.model ? applyModel(o.model, now, o) : null;
  return a && a.carbRatio > 0 ? a.carbRatio : null;
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
  carbPercentAbsorbedAtPercentTime,
  activeInsulin,
  carbsOnBoard,
  mergeMealCarbsIntoBoluses,
  roundDose,
  insulinActionWithin,
  carbAbsorptionWithin,
  insulinEffectBetween,
  carbEffectBetween,
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
  retrospectiveCorrection,
  retrospectiveEffectAt,
  // Stage 3 API
  glucoseStats,
  timeInRange,
  analyzePatterns,
  // Stage 4 API
  buildWorkoutTypeProfiles,
  workoutLiveAlert,
  hypoForecast2h,
  hyperForecast2h,
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
  preventativeUnplugBolusAdvice,
  estimateUnplugImpact,
  // Stage 5 API
  mealMemory,
  suggestMealDose,
  insulinHealthCheck,
  sensitivityMap,
  SENSITIVITY_TOD_BUCKETS,
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
  carbRatioByWindowReview,
  correctionFactorByWindowReview,
  regimenReview,
  regimenReviewByProfile,
  resolveActiveProfileAt,
  REGIMEN_MAX_PCT_CHANGE,
  // Stage 7 API
  forecastAccuracy,
  forecastAccuracyByBlock,
  // Stage 8 API — learning
  prepareLearningInput,
  basalDeviationUnits,
  episodeContext,
  scoreCorrectionEpisode,
  scoreMealEpisode,
  scoreExerciseEpisode,
  scoreNight,
  fitModel,
  applyModel,
  modelOpts,
};

// Dual environment: CommonJS (Node/Netlify functions) or a plain <script>
// tag in the browser, where `module` doesn't exist.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DiabetesEngine;
} else if (typeof window !== 'undefined') {
  window.DiabetesEngine = DiabetesEngine;
}

})();
