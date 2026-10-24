'use strict';

// fitl00p's own Body Battery (5-100), simulated minute by minute from
// Apple Watch data. Not a copy of Garmin's formula (unpublished) — the logic
// follows what Lewis's own Garmin history (Feb-Dec 2025: 236 nights, 229
// days, 82 workouts) shows actually drives the score:
//   - overnight recharge is mostly about sleep QUALITY (Garmin's sleep
//     stress ~ overnight HRV: r = -0.87), not length (r = 0.15). Charge is
//     roughly steady per hour of sleep (~7-8%/h), scaled by quality, and
//     reduced by a late bedtime (after midnight ~20% slower) and a hard
//     previous day (r = -0.32);
//   - awake drain is proportional to how full you are (r = 0.90: ~3.3%/h
//     on days you wake above 60%, ~1.4%/h below 40%) — it slows as it
//     empties; stress/steps add little (|r| <= 0.2), so raised heart rate
//     only adds a modest extra; calm rest recharges a little;
//   - workouts drain by effort (Banister TRIMP from heart rate; ~0.22 per
//     TRIMP, which matched that history);
//   - 5 is the floor, 100 the ceiling.
// Pure functions — unit-tested in tests/body-battery.test.js.
(function () {

const MIN = 60000;
const FLOOR = 5, CEIL = 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const K = {
  sleepGainPerHr: 7.5,    // % per hour asleep on a normal-quality night (6.5h from 5% -> ~54%)
  awakeDrainPerHr: 0.08,  // fraction of the CURRENT level lost per awake hour (at 60%: ~4.8/h, at 20%: ~1.6/h)
  restPerMin: 0.0004,     // calm awake rest: fraction of the gap to 100 regained per minute (~1.5%/h at 60)
  restHrr: 0.08,          // below this heart-rate-reserve fraction, awake time counts as rest
  stressSlope: 0.25,      // modest extra %/min drain = stressSlope * (hrr - restHrr)^1.3 (stress mattered little)
  exercisePerTrimp: 0.22, // workout drain per Banister TRIMP unit (60 min at HRR 0.73 ~ 114 TRIMP ~ -25)
  hrStaleMin: 20,         // a heart-rate sample stays "current" this long
};

// Banister TRIMP for one minute at heart-rate-reserve fraction hrr.
function trimpPerMinute(hrr, isFemale) {
  return isFemale ? hrr * 0.86 * Math.exp(1.67 * hrr) : hrr * 0.64 * Math.exp(1.92 * hrr);
}

// Overnight charge quality, 1 = a normal night. Overnight HRV vs your normal
// is the main driver (calm nights recharged ~2x restless ones); resting HR
// a little; a bedtime after midnight and a hard previous day (strain 0-21)
// each take some off. bedHour: local clock hour sleep started (e.g. 23.5;
// times after midnight as 24.5 etc).
function sleepQuality(hrvZ, rhrZ, { bedHour = null, prevStrain = null } = {}) {
  let q = 1 + 0.30 * (hrvZ || 0) - 0.10 * (rhrZ || 0);
  if (bedHour != null && bedHour > 23.5) q *= 1 - 0.2 * Math.min(1, (bedHour - 23.5) / 1.5);
  if (prevStrain != null && prevStrain > 10) q *= 1 - 0.15 * Math.min(1, (prevStrain - 10) / 8);
  return clamp(q, 0.4, 1.6);
}

// Heart rate at time t from sorted samples [{ t, bpm }]: the latest sample
// at or before t, if it's within hrStaleMin. idx is a moving cursor.
function makeHrLookup(samples) {
  let i = 0;
  return t => {
    while (i + 1 < samples.length && samples[i + 1].t <= t) i++;
    const s = samples[i];
    if (!s || s.t > t || t - s.t > K.hrStaleMin * MIN) return null;
    return s.bpm;
  };
}

/**
 * Simulate the battery from `start` to `now` (ms), one-minute steps.
 * opts:
 *   startLevel     assumed level at `start`
 *   sleeps         [{ start, end, asleepHrs, quality }]  (quality from sleepQuality)
 *   workouts       [{ start, end, name, avgHr }]
 *   hrSamples      [{ t, bpm }] sorted (may be empty)
 *   restingHr, hrMax, isFemale
 *   stressFactor   multiplier on awake stress drain (from today's HRV, 0.75-1.5)
 *   breakdownFrom  ms — contributions are counted from here (e.g. last bedtime)
 * Returns { level, levelAtBreakdown, series:[{t, level}], parts, workouts:[{name, delta}], ratePerHr }.
 */
function simulate(opts) {
  const { start, now, startLevel = 30, sleeps = [], workouts = [], hrSamples = [],
    restingHr = 60, hrMax = 185, isFemale = false, stressFactor = 1, breakdownFrom = start } = opts;
  const hrAt = makeHrLookup(hrSamples);
  const hrrOf = bpm => clamp((bpm - restingHr) / Math.max(1, hrMax - restingHr), 0, 1);
  const parts = { sleep: 0, rest: 0, exercise: 0, stress: 0, awake: 0 };
  const perWorkout = workouts.map(w => ({ name: w.name, start: w.start, end: w.end, delta: 0 }));
  const series = [];
  let L = clamp(startLevel, FLOOR, CEIL);
  let levelAtBreakdown = breakdownFrom <= start ? L : null;
  const recent = []; // last 30 one-minute deltas while awake & not exercising

  for (let t = start; t < now; t += MIN) {
    if (levelAtBreakdown == null && t >= breakdownFrom) levelAtBreakdown = L;
    if ((t - start) % (15 * MIN) === 0) series.push({ t, level: L });

    let d = 0, kind;
    const sleep = sleeps.find(s => t >= s.start && t < s.end);
    const wIdx = sleep ? -1 : workouts.findIndex(w => t >= w.start && t < w.end);
    if (sleep) {
      const spanHrs = Math.max(0.25, (sleep.end - sleep.start) / 3600000);
      const efficiency = clamp((sleep.asleepHrs ?? spanHrs) / spanHrs, 0.3, 1);
      d = (K.sleepGainPerHr / 60) * (sleep.quality ?? 1) * efficiency; kind = 'sleep';
    } else if (wIdx >= 0) {
      const bpm = hrAt(t) ?? workouts[wIdx].avgHr;
      d = bpm != null ? -K.exercisePerTrimp * trimpPerMinute(hrrOf(bpm), isFemale) : -(K.awakeDrainPerHr / 60) * L * 2;
      kind = 'exercise';
    } else {
      const bpm = hrAt(t);
      const base = -(K.awakeDrainPerHr / 60) * L; // drain slows as the battery empties
      if (bpm == null) { d = base; kind = 'awake'; }
      else {
        const hrr = hrrOf(bpm);
        if (hrr < K.restHrr) { d = (CEIL - L) * K.restPerMin; kind = 'rest'; }
        else { d = base - K.stressSlope * Math.pow(hrr - K.restHrr, 1.3) * stressFactor; kind = 'stress'; }
      }
    }

    const next = clamp(L + d, FLOOR, CEIL);
    const applied = next - L;
    L = next;
    if (t >= breakdownFrom) {
      parts[kind] += applied;
      if (kind === 'exercise') perWorkout[wIdx].delta += applied;
    }
    if (kind !== 'exercise' && kind !== 'sleep') { recent.push(applied); if (recent.length > 30) recent.shift(); }
  }
  if (levelAtBreakdown == null) levelAtBreakdown = L;
  series.push({ t: now, level: L });
  const ratePerHr = recent.length ? (recent.reduce((a, b) => a + b, 0) / recent.length) * 60 : -K.awakeDrainPerHr * L;
  return { level: L, levelAtBreakdown, series, parts, workouts: perWorkout.filter(w => w.delta !== 0), ratePerHr };
}

// HealthKit sleep segments [{ start, end, asleep }] (ms) -> sessions
// [{ start, end, asleepHrs }]: segments less than 90 min apart join one
// session (a nap is its own session); sessions with no asleep time dropped.
function groupSleepSessions(segments) {
  const sorted = (segments || []).filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const cur = out[out.length - 1];
    if (cur && s.start - cur.end <= 90 * MIN) {
      cur.end = Math.max(cur.end, s.end);
      if (s.asleep) cur.asleepHrs += (s.end - s.start) / 3600000;
    } else {
      out.push({ start: s.start, end: s.end, asleepHrs: s.asleep ? (s.end - s.start) / 3600000 : 0 });
    }
  }
  return out.filter(s => s.asleepHrs > 0);
}

// Garmin's zone names for a level.
function zoneOf(level) {
  if (level >= 76) return { key: 'high', label: 'High reserve — ready for hard training' };
  if (level >= 51) return { key: 'medium', label: 'Medium reserve — fine for moderate activity' };
  if (level >= 26) return { key: 'low', label: 'Low reserve — keep it light' };
  return { key: 'verylow', label: 'Very low — prioritise rest and sleep' };
}

const BodyBattery = { simulate, sleepQuality, trimpPerMinute, zoneOf, groupSleepSessions, K };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BodyBattery;
} else if (typeof window !== 'undefined') {
  window.BodyBattery = BodyBattery;
}

})();
