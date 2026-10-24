'use strict';
// Deterministic simulated type-1 patient (Tandem + Control-IQ) for learning tests.
// Glucose is generated from the engine's own iobFraction / cobFraction curves, so the
// hidden `truth` (ISF/CR by London hour, exercise effect) is exactly recoverable.
const E = require('../../src/diabetes-engine.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const londonFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
const _hourCache = new Map();
function londonHour(ms) {
  const k = Math.floor(ms / 3600000);
  let h = _hourCache.get(k);
  if (h === undefined) { h = Number(londonFmt.format(new Date(k * 3600000))); _hourCache.set(k, h); }
  return h;
}

const DEFAULT_ISF = h => (h < 4 ? 3.2 : h < 9 ? 2.2 : h < 17 ? 3.0 : 3.6);   // mmol/L per U
const DEFAULT_CR = h => (h < 11 ? 8 : h < 17 ? 10 : 12);                      // g per U
const DEFAULT_BASAL = h => (h < 6 ? 0.8 : 0.9);                               // U/h
const DEFAULT_EXERCISE = {
  Running: { dropPerMin: 0.03, sensitivityBoost: 1.3, hours: 6 },
  Weights: { dropPerMin: 0.015, sensitivityBoost: 1.15, hours: 4 },
};

function simulatePatient(opts = {}) {
  const {
    days = 60, seed = 1, startMs = Date.UTC(2026, 0, 5),
    isfByHour = DEFAULT_ISF, carbRatioByHour = DEFAULT_CR, scheduledBasalByHour = DEFAULT_BASAL,
    exercise = DEFAULT_EXERCISE, controlIq = true, autoBolus = true,
    unloggedSnackRate = 0.05,   // chance per waking hour (07-22 London)
    compressionLowRate = 0.02,  // scaled x5 -> per-night chance
    noiseSd = 0.3, sensorLagMin = 8,
  } = opts;
  const rand = mulberry32(seed);
  const randn = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const STEP = 5, MS = STEP * 60000, steps = days * 288;
  const lag = Math.round(sensorLagMin / STEP);
  const wTypes = Object.keys(exercise);

  // per-step fraction absorbed (k -> k+1) from the engine curves
  const insDec = [], carbDec = [];
  for (let k = 0; k < 48; k++) insDec.push(E.iobFraction(k * STEP, E.IOB_PEAK_MINUTES, 240) - E.iobFraction((k + 1) * STEP, E.IOB_PEAK_MINUTES, 240));
  for (let k = 0; k < 36; k++) carbDec.push(E.cobFraction(k * STEP, 180) - E.cobFraction((k + 1) * STEP, 180));

  const out = { glucoseHistory: [], boluses: [], corrections: [], basalDoses: [], workouts: [], snacks: [], compressionLows: [] };
  const trueG = [], insDoses = [], carbDoses = [], exWin = [];
  let g = 7, noise = 0, compUntil = -1, compDepth = 0;
  let lastMeal = -999, lastCorr = -999, lastAuto = -999, workoutEnd = -1;

  // daily plan (London minute-of-day, rounded to 5)
  const plan = [];
  for (let d = 0; d < days + 1; d++) {
    const meals = [[480, 40, 25], [780, 40, 35], [1140, 40, 45]].map(([b, j, c]) => ({
      min: Math.round((b + (rand() - 0.5) * j) / 5) * 5, carbs: Math.round(c + (rand() - 0.5) * 30) }));
    plan.push({ meals, workout: rand() < 0.5 ? wTypes[Math.floor(rand() * wTypes.length)] : null,
      comp: rand() < compressionLowRate * 5 ? Math.round((60 + rand() * 240) / 5) * 5 : -1 });
  }

  const addIns = (i, units, hour) => insDoses.push({ i, units, isf: isfByHour(hour) });
  for (let i = 0; i < steps; i++) {
    const t = startMs + i * MS, hour = londonHour(t);
    const mod = hour * 60 + new Date(t).getUTCMinutes();
    const day = plan[Math.floor(i / 288)];
    // sensor reading (lagged, noisy; compression lows are sensor-only)
    noise = 0.7 * noise + noiseSd * 0.7 * randn();
    let meas = (trueG[Math.max(0, i - lag)] ?? g) + noise;
    if (i <= compUntil) meas -= compDepth;
    meas = Math.min(22.2, Math.max(2.2, meas));
    out.glucoseHistory.push({ time: t, value: +meas.toFixed(2) });
    trueG.push(g);
    if (day.comp === mod && compUntil < i) {
      compUntil = i + 7; compDepth = 3 + rand() * 1.5; out.compressionLows.push({ time: t });
    }

    // meals
    for (const m of day.meals) if (m.min === mod) {
      const cr = carbRatioByHour(hour), units = Math.max(0.5, Math.round(m.carbs / cr * (1 + 0.05 * randn()) * 20) / 20);
      out.boluses.push({ time: t, units, carbs: m.carbs, mealName: null });
      addIns(i, units, hour);
      carbDoses.push({ i, g: m.carbs, perG: isfByHour(hour) / cr });
      lastMeal = i;
    }
    // unlogged snacks
    if (hour >= 7 && hour < 22 && mod % 60 === 0 && rand() < unloggedSnackRate) {
      const gr = 10 + Math.round(rand() * 20);
      carbDoses.push({ i, g: gr, perG: isfByHour(hour) / carbRatioByHour(hour) });
      out.snacks.push({ time: t, carbs: gr });
    }
    // workouts at 17:30 London
    if (day.workout && mod === 1050 && i > workoutEnd) {
      const dur = 30 + Math.round(rand() * 3) * 15, type = day.workout, ex = exercise[type];
      out.workouts.push({ startTime: t, endTime: t + dur * 60000, workoutType: type, avgHr: 125 + Math.round(rand() * 30) });
      workoutEnd = i + dur / STEP;
      exWin.push({ s: i, e: workoutEnd, until: workoutEnd + ex.hours * 12, ex });
    }
    // manual correction
    if (meas > 9.5 && i - lastCorr > 36 && i - lastMeal > 24 && i - lastAuto > 12 && rand() < 0.4) {
      const units = Math.max(0.3, Math.round((meas - 6.5) / isfByHour(hour) * 20) / 20);
      out.corrections.push({ time: t, units, startGlucose: +meas.toFixed(2), predictedGlucose: null });
      addIns(i, units, hour); lastCorr = i;
    }
    // Control-IQ: temp basal deviating from schedule, optional auto-bolus
    if (controlIq) {
      const sched = scheduledBasalByHour(hour), prev = out.glucoseHistory[i - 1]?.value ?? meas;
      const eventual = meas + (meas - prev) * 4;
      let rate = sched * (1 + 0.4 * (eventual - 6.5));
      if (eventual < 4.4) rate = 0;
      rate = Math.min(sched * 3, Math.max(0, rate));
      if (Math.abs(rate - sched) > 0.005) {
        out.basalDoses.push({ time: t, units: rate / 12, durationMin: 5, rate: +rate.toFixed(3) });
        addIns(i, (rate - sched) / 12, hour);
      }
      if (autoBolus && meas > 11.5 && eventual > 12 && i - lastAuto > 12) {
        const units = Math.round((meas - 8) / isfByHour(hour) * 0.4 * 20) / 20;
        if (units > 0) { out.boluses.push({ time: t, units, carbs: 0, auto: true }); addIns(i, units, hour); lastAuto = i; }
      }
    }

    // advance true glucose one step
    let boost = 1, d = 0;
    for (const w of exWin) {
      if (i >= w.s && i <= w.until) boost = Math.max(boost, w.ex.sensitivityBoost);
      if (i >= w.s && i < w.e) d -= w.ex.dropPerMin * STEP;
    }
    for (const x of insDoses) { const k = i - x.i; if (k < 48) d -= x.units * x.isf * boost * insDec[k]; }
    for (const x of carbDoses) { const k = i - x.i; if (k < 36) d += x.g * x.perG * carbDec[k]; }
    while (insDoses.length && i - insDoses[0].i >= 47) insDoses.shift();
    while (carbDoses.length && i - carbDoses[0].i >= 35) carbDoses.shift();
    while (exWin.length && i > exWin[0].until) exWin.shift();
    g = Math.min(22.2, Math.max(2.2, g + d + 0.04 * randn()));
  }

  // pump profile: deliberately wrong (flat ISF at truth 24h mean, CR 20% too high)
  const hrs = [...Array(24).keys()];
  const meanIsf = hrs.reduce((a, h) => a + isfByHour(h), 0) / 24;
  const meanCr = hrs.reduce((a, h) => a + carbRatioByHour(h), 0) / 24;
  const pumpProfile = { default: [0, 3, 6, 9, 12, 15, 18, 21].map(h => ({
    time: String(h).padStart(2, '0') + ':00', correctionFactor: +meanIsf.toFixed(3),
    carbRatio: +(meanCr * 1.2).toFixed(3), basalRate: scheduledBasalByHour(h) })) };

  return {
    glucoseHistory: out.glucoseHistory, boluses: out.boluses, corrections: out.corrections,
    basalDoses: out.basalDoses, activities: { workouts: out.workouts }, pumpProfile,
    truth: { isfByHour, carbRatioByHour, scheduledBasalByHour, exercise, snacks: out.snacks,
      compressionLows: out.compressionLows, pumpIsf: meanIsf, pumpCarbRatioFactor: 1.2 },
  };
}

module.exports = { simulatePatient, mulberry32, londonHour };
