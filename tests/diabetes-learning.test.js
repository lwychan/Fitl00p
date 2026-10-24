const test = require('node:test');
const assert = require('node:assert');
const { simulatePatient, londonHour } = require('./fixtures/sim-patient.js');

test('sim patient: 60 days of plausible data', () => {
  const t0 = Date.now();
  const p = simulatePatient({ days: 60, seed: 1 });
  const elapsed = Date.now() - t0;
  const n = p.glucoseHistory.length;
  assert.ok(Math.abs(n - 60 * 288) <= 0.05 * 60 * 288, `length ${n}`);
  for (const g of p.glucoseHistory) assert.ok(g.value >= 2.2 && g.value <= 22.2, `value ${g.value}`);
  for (let i = 1; i < n; i++) assert.strictEqual(p.glucoseHistory[i].time - p.glucoseHistory[i - 1].time, 300000);
  const meals = p.boluses.filter(b => !b.auto && b.carbs > 0);
  assert.ok(meals.length >= 150, `meal boluses ${meals.length}`);
  assert.ok(p.corrections.length >= 30, `corrections ${p.corrections.length}`);
  assert.ok(p.truth.snacks.length > 0);
  assert.ok(p.basalDoses.length > 0);
  assert.ok(p.activities.workouts.length > 0);
  assert.ok(p.pumpProfile.default.length > 0);
  assert.ok(elapsed < 10000, `took ${elapsed}ms`);   // loose: just guards against pathological slowness
  assert.deepStrictEqual(simulatePatient({ days: 60, seed: 1 }), p);
  assert.notDeepStrictEqual(simulatePatient({ days: 5, seed: 2 }).glucoseHistory, simulatePatient({ days: 5, seed: 3 }).glucoseHistory);
});

const H = 3600000;
const sim60 = simulatePatient({ days: 60, seed: 1 });

// Every unlogged disturbance the sim injects is in truth: snacks and compression lows (there are
// no hidden drifts; highs come from logged, partly under-dosed meals - truth.underdosedMeals).
function confoundTimes(p) {
  return [
    ...p.boluses.filter(b => !b.auto && b.carbs > 0).map(b => b.time),
    ...p.truth.snacks.map(x => x.time), ...p.truth.compressionLows.map(x => x.time),
  ];
}

test('sim patient: clean corrections spread across all eight 3h London blocks', () => {
  const p = sim60;
  const confounds = confoundTimes(p);
  assert.ok(p.truth.underdosedMeals.length > 20);
  // clean = no meal / snack / compression low within 3h before (carbs absorbed) or 2h after the correction
  const clean = Array(8).fill(0);
  for (const c of p.corrections) {
    if (!confounds.some(t => t > c.time - 3 * H && t < c.time + 2 * H)) clean[Math.floor(londonHour(c.time) / 3)]++;
  }
  for (let b = 0; b < 8; b++) assert.ok(clean[b] >= 8, `block ${b} has ${clean[b]} clean corrections (${clean})`);
});

test('sim patient: >= 20 corrections are followed by an unlogged snack within 3h', () => {
  const p = sim60;
  const n = p.corrections.filter(c => p.truth.snacks.some(x => x.time > c.time && x.time <= c.time + 3 * H)).length;
  assert.ok(n >= 20, `only ${n} snack-overlapping corrections`);
});

test('sim patient: nights inside a post-exercise boost window, with insulin activity', () => {
  const p = sim60;
  const nights = new Set();
  for (const w of p.activities.workouts) {
    const boostEnd = w.endTime + p.truth.exercise[w.workoutType].hours * H;
    // each London night 00:00-06:00 fully covered by the boost window
    for (let t = Math.floor(w.endTime / H) * H; t < boostEnd; t += H) {
      if (londonHour(t) !== 0) continue;
      if (t < w.endTime || t + 6 * H > boostEnd) continue;
      const active = p.basalDoses.some(b => b.time >= t && b.time < t + 6 * H) ||
        p.corrections.some(c => c.time >= t && c.time < t + 6 * H);
      if (active) nights.add(t);
    }
  }
  assert.ok(nights.size >= 10, `only ${nights.size} boosted nights`);
});

test('sim patient: realistic lows and no clamping of true glucose', () => {
  const v = sim60.glucoseHistory.map(g => g.value);
  const low = v.filter(x => x < 3.9).length / v.length;
  assert.ok(low < 0.05, `share <3.9 = ${low}`);
  assert.strictEqual(sim60.truth.clampedCount, 0);
});

/* ── Task 3: correction episodes (whole-curve fit) ─────────────────── */
const E = require('../src/diabetes-engine.js');

function simInput(p) {
  return { glucoseHistory: p.glucoseHistory, boluses: p.boluses, corrections: p.corrections,
    basalDoses: p.basalDoses, activities: p.activities };
}
const simEnd = sim60.glucoseHistory[sim60.glucoseHistory.length - 1].time;
const simEpisodes = sim60.corrections.map(c => ({ c,
  ep: E.scoreCorrectionEpisode(simInput(sim60), c, { pumpProfile: sim60.pumpProfile, nowMs: simEnd }) }));
// post-workout sensitivity boost is learned separately; keep its windows out of ISF recovery
function inBoost(p, startMs, endMs) {
  return p.activities.workouts.some(w =>
    startMs < w.endTime + p.truth.exercise[w.workoutType].hours * H && endMs > w.startTime);
}
const cleanSimEpisodes = simEpisodes.filter(({ c, ep }) =>
  ep && ep.confounded === null && !inBoost(sim60, c.time, c.time + 4 * H));
const isfErr = ({ c, ep }) => Math.abs(ep.fit.isf - sim60.truth.isfByHour(londonHour(c.time))) / sim60.truth.isfByHour(londonHour(c.time));
const meanOf = a => a.reduce((s, x) => s + x, 0) / a.length;

test('correction ISF recovered within 15% of truth at its hour', () => {
  assert.ok(cleanSimEpisodes.length >= 30, `only ${cleanSimEpisodes.length} clean episodes`);
  const err = meanOf(cleanSimEpisodes.map(isfErr));
  const byBlock = Array.from({ length: 8 }, (_, b) => {
    const e = cleanSimEpisodes.filter(x => Math.floor(londonHour(x.c.time) / 3) === b).map(isfErr);
    return e.length ? `${b * 3}h:${(meanOf(e) * 100).toFixed(1)}%(n=${e.length})` : `${b * 3}h:-`;
  });
  console.log(`ISF mean abs err ${(err * 100).toFixed(1)}% over ${cleanSimEpisodes.length}; ${byBlock.join(' ')}`);
  assert.ok(err <= 0.15, `mean abs % error ${(err * 100).toFixed(1)}`);
  for (const { ep } of cleanSimEpisodes) {
    assert.strictEqual(ep.kind, 'correction');
    assert.ok(Number.isFinite(ep.fit.rmse) && ep.fit.n > 0);
  }
});

test('prior IOB does not bias ISF (beats v1 single-reading method)', () => {
  // the sim sizes corrections net of IOB, so few have >= 1u on board: pool five patients
  const withIob = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const p = seed === 1 ? sim60 : simulatePatient({ days: 60, seed });
    const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
    for (const c of p.corrections) {
      const ep = E.scoreCorrectionEpisode(simInput(p), c, { pumpProfile: p.pumpProfile, nowMs });
      if (!ep || ep.confounded !== null || inBoost(p, c.time, c.time + 4 * H) || ep.context.iob < 1) continue;
      const truth = p.truth.isfByHour(londonHour(c.time));
      // v1 resolveCorrection, reproduced inline: (start - reading nearest 3h after) / units
      const target = c.time + 3 * H;
      let best = null;
      for (const r of p.glucoseHistory) if (!best || Math.abs(r.time - target) < Math.abs(best.time - target)) best = r;
      withIob.push({ newErr: Math.abs(ep.fit.isf - truth) / truth, oldErr: Math.abs((c.startGlucose - best.value) / c.units - truth) / truth });
    }
  }
  assert.ok(withIob.length >= 10, `only ${withIob.length} episodes with IOB >= 1u`);
  const newErr = meanOf(withIob.map(x => x.newErr)), oldErr = meanOf(withIob.map(x => x.oldErr));
  console.log(`IOB>=1u episodes n=${withIob.length}: new ${(newErr * 100).toFixed(1)}%, v1 ${(oldErr * 100).toFixed(1)}%`);
  assert.ok(newErr <= 0.15, `new method ${(newErr * 100).toFixed(1)}%`);
  assert.ok(oldErr > 0.25, `v1 method only ${(oldErr * 100).toFixed(1)}% off`);
  assert.ok(newErr < oldErr);
});

test('unlogged snack flagged as unexplained-rise', () => {
  // A snack needs ~90 min inside the 4h window to show as a sustained rise, so "overlapping"
  // = eaten 0-150 min after the dose. Episodes already confounded by an earlier rule
  // (logged carbs in the window, compression low, sensor gap) keep that label instead.
  const overlapping = simEpisodes.filter(({ c, ep }) => ep &&
    !['carbs-in-window', 'compression-low', 'sensor-gap', 'too-few-readings'].includes(ep.confounded) &&
    sim60.truth.snacks.some(s => s.time >= c.time && s.time <= c.time + 150 * 60000));
  assert.ok(overlapping.length >= 10, `only ${overlapping.length} snack-overlapping episodes`);
  const flagged = overlapping.filter(({ ep }) => ep.confounded === 'unexplained-rise').length;
  console.log(`snack-overlapping: ${flagged}/${overlapping.length} unexplained-rise; others: ${overlapping.filter(({ ep }) => ep.confounded !== 'unexplained-rise').map(({ ep }) => ep.confounded).join(',')}`);
  assert.ok(flagged / overlapping.length >= 0.8, `${flagged}/${overlapping.length}`);
});

test('auto-bolus never learned from', () => {
  const c = sim60.corrections[5];
  const ep = E.scoreCorrectionEpisode(simInput(sim60), { ...c, auto: true }, { pumpProfile: sim60.pumpProfile, nowMs: simEnd });
  assert.strictEqual(ep.confounded, 'auto-bolus');
});

test('scoreCorrectionEpisode is null until the window has elapsed', () => {
  const c = sim60.corrections[5];
  assert.strictEqual(E.scoreCorrectionEpisode(simInput(sim60), c, { pumpProfile: sim60.pumpProfile, nowMs: c.time + 239 * 60000 }), null);
  assert.ok(E.scoreCorrectionEpisode(simInput(sim60), c, { pumpProfile: sim60.pumpProfile, nowMs: c.time + 240 * 60000 }));
});

test('basalDeviationUnits: 1h at temp 0 vs scheduled 0.8 -> -0.8', () => {
  const t0 = Date.UTC(2026, 0, 6, 1);   // 01:00 London (GMT)
  const profile = { default: [{ time: '00:00', basalRate: 0.8 }, { time: '06:00', basalRate: 0.9 }] };
  const dev = E.basalDeviationUnits([{ time: t0, units: 0, durationMin: 60, rate: 0 }], profile, t0, t0 + H);
  assert.ok(Math.abs(dev - -0.8) < 1e-9, `got ${dev}`);
  // no temp records -> pump ran the schedule -> no deviation
  assert.strictEqual(E.basalDeviationUnits([], profile, t0, t0 + H), 0);
});

test('episodeContext fills what it can and nulls the rest', () => {
  const c = sim60.corrections[5];
  const ctx = E.episodeContext(simInput(sim60), c.time, { pumpProfile: sim60.pumpProfile });
  assert.strictEqual(ctx.hour, londonHour(c.time));
  assert.strictEqual(typeof ctx.weekend, 'boolean');
  assert.ok(Number.isFinite(ctx.iob) && Number.isFinite(ctx.cob) && Number.isFinite(ctx.startGlucose));
  assert.ok(Array.isArray(ctx.exercise24h.types) && Array.isArray(ctx.exercise48h.types));
  assert.strictEqual(ctx.siteAgeHours, null);
  assert.strictEqual(ctx.rhrZ, null);
  assert.strictEqual(ctx.sleepHrs, null);
});

/* ── Task 3 fix round 1 ─────────────────────────────────────────────── */
const sim90 = [1, 2, 3, 4, 5, 6, 7].map(seed => simulatePatient({ days: 90, seed }));

test('clean episodes never carry an implausible ISF (seeds 1-7 x 90 days)', () => {
  let clean = 0, implausible = 0;
  for (const p of sim90) {
    const P = E.prepareLearningInput(simInput(p));
    const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
    for (const c of p.corrections) {
      const ep = E.scoreCorrectionEpisode(P, c, { pumpProfile: p.pumpProfile, nowMs });
      if (!ep) continue;
      if (ep.confounded === 'implausible-fit') { implausible++; assert.ok(ep.fit.isf != null); }
      if (ep.confounded !== null) continue;
      clean++;
      assert.ok(ep.fit.isf >= 0.5 && ep.fit.isf <= 15, `clean episode with isf ${ep.fit.isf}`);
    }
  }
  console.log(`seeds 1-7 x 90d: ${clean} clean, ${implausible} implausible-fit`);
  assert.ok(clean > 300);
});

test('missing pump profile -> missing-profile, never clean', () => {
  const p = sim90[1];
  const P = E.prepareLearningInput(simInput(p));
  const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
  const eps = p.corrections.map(c => E.scoreCorrectionEpisode(P, c, { nowMs })).filter(Boolean);
  assert.ok(eps.length > 50);
  assert.strictEqual(eps.filter(ep => ep.confounded === null).length, 0);
  for (const ep of eps) if (!ep.confounded || ep.confounded === 'missing-profile') assert.strictEqual(ep.fit.isf, null);
  assert.ok(eps.filter(ep => ep.confounded === 'missing-profile').length > 50);
  // profile without a carb ratio is just as unusable
  const noCr = { default: p.pumpProfile.default.map(({ carbRatio, ...s }) => s) };
  const ep = E.scoreCorrectionEpisode(P, p.corrections[3], { pumpProfile: noCr, nowMs });
  assert.strictEqual(ep.confounded, 'missing-profile');
});

test('prepared input: fast and identical to the raw path', () => {
  const p = sim90[0];
  const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
  const t0 = process.hrtime.bigint();
  const P = E.prepareLearningInput(simInput(p));
  const prepared = p.corrections.map(c => E.scoreCorrectionEpisode(P, c, { pumpProfile: p.pumpProfile, nowMs }));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`90-day seed 1: ${p.corrections.length} corrections scored (prepared, incl. prepare) in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `took ${ms} ms`);
  for (let i = 0; i < p.corrections.length; i += 10) {
    assert.deepStrictEqual(E.scoreCorrectionEpisode(simInput(p), p.corrections[i], { pumpProfile: p.pumpProfile, nowMs }), prepared[i]);
  }
  assert.strictEqual(E.basalDeviationUnits(P, p.pumpProfile, nowMs - 24 * H, nowMs),
    E.basalDeviationUnits(p.basalDoses, p.pumpProfile, nowMs - 24 * H, nowMs));
});

test('duplicate readings and a dose logged in boluses are not double-counted', () => {
  const p = sim60;
  const { c, ep } = cleanSimEpisodes[0];
  const dup = { ...simInput(p), glucoseHistory: [...p.glucoseHistory, ...p.glucoseHistory] };
  const epDup = E.scoreCorrectionEpisode(dup, c, { pumpProfile: p.pumpProfile, nowMs: simEnd });
  assert.strictEqual(epDup.fit.n, ep.fit.n);
  assert.ok(ep.fit.n <= 48);
  assert.strictEqual(epDup.fit.isf, ep.fit.isf);
  // the same dose arriving via boluses instead of corrections
  const viaBolus = { ...simInput(p), corrections: p.corrections.filter(x => x !== c), boluses: [...p.boluses, { time: c.time, units: c.units, carbs: 0 }] };
  const epB = E.scoreCorrectionEpisode(viaBolus, c, { pumpProfile: p.pumpProfile, nowMs: simEnd });
  assert.ok(Math.abs(epB.fit.isf - ep.fit.isf) < 1e-9, `${epB.fit.isf} vs ${ep.fit.isf}`);
});

/* ── Task 4: meal episodes (hindsight dose) ─────────────────────────── */
// ISF comes from truth so the meal fit isolates CR learning.
const mealOpts = (p, nowMs) => ({ pumpProfile: p.pumpProfile, isfAt: ms => p.truth.isfByHour(londonHour(ms)), nowMs });
const loggedMeals = p => p.boluses.filter(b => !b.auto && b.carbs > 0);
const P60 = E.prepareLearningInput(simInput(sim60));
let _meals = null;   // scored lazily, once
function meals60() {
  if (!_meals) {
    const all = loggedMeals(sim60).map(b => ({ b, ep: E.scoreMealEpisode(P60, b, mealOpts(sim60, simEnd)) }));
    _meals = { all, clean: all.filter(({ b, ep }) => ep && ep.confounded === null && !inBoost(sim60, b.time, b.time + 5 * H)) };
  }
  return _meals;
}
const trueCr = (p, ms) => p.truth.carbRatioByHour(londonHour(ms));
const crErr = ({ b, ep }) => Math.abs(ep.fit.carbRatio - trueCr(sim60, b.time)) / trueCr(sim60, b.time);

test('meal CR recovered within 15% per block', () => {
  const { all: mealEpisodes, clean: cleanMealEpisodes } = meals60();
  assert.ok(cleanMealEpisodes.length >= 40, `only ${cleanMealEpisodes.length} clean meal episodes`);
  const tested = [];
  const report = [];
  for (let blk = 0; blk < 8; blk++) {
    const e = cleanMealEpisodes.filter(x => Math.floor(londonHour(x.b.time) / 3) === blk).map(crErr);
    report.push(e.length ? `${blk * 3}h:${(meanOf(e) * 100).toFixed(1)}%(n=${e.length})` : `${blk * 3}h:-`);
    if (e.length >= 5) tested.push({ blk, err: meanOf(e), n: e.length });
  }
  const conf = {};
  for (const { ep } of mealEpisodes) if (ep && ep.confounded) conf[ep.confounded] = (conf[ep.confounded] || 0) + 1;
  console.log(`meal CR per block: ${report.join(' ')}; confounded ${JSON.stringify(conf)}`);
  assert.ok(tested.length >= 4, `only ${tested.length} blocks with >= 5 clean meals`);
  for (const { blk, err, n } of tested) assert.ok(err <= 0.15, `block ${blk * 3}h: ${(err * 100).toFixed(1)}% (n=${n})`);
  for (const { b, ep } of cleanMealEpisodes) {
    assert.strictEqual(ep.kind, 'meal');
    assert.strictEqual(ep.carbs, b.carbs);
    assert.strictEqual(ep.units, b.units);
    assert.ok(Number.isFinite(ep.fit.rmse) && ep.fit.n > 0 && Number.isFinite(ep.fit.peakMin));
    assert.ok(Math.abs(ep.fit.idealUnits - b.carbs / ep.fit.carbRatio) < 1e-9);
    assert.ok(Math.abs(ep.deltaUnits - (ep.fit.idealUnits - b.units)) < 1e-9);
  }
});

test('under-dosed meal -> idealUnits > units', () => {
  const cleanMealEpisodes = meals60().clean;
  // The patient doses from the pump CR (20% above the 24h-mean truth), so a full-dose
  // morning meal (truth CR 8) gets ~70% of what it needed.
  const at70 = cleanMealEpisodes.filter(({ b }) => {
    const share = b.units / (b.carbs / trueCr(sim60, b.time));
    return share >= 0.65 && share <= 0.75;
  });
  assert.ok(at70.length >= 5, `only ${at70.length} clean meals dosed at ~70%`);
  const ratios = at70.map(({ b, ep }) => ep.fit.idealUnits / b.units);
  console.log(`~70%-dosed meals n=${at70.length}: idealUnits/units mean ${meanOf(ratios).toFixed(2)} [${ratios.map(r => r.toFixed(2)).join(' ')}]`);
  for (const { b, ep } of at70) assert.ok(ep.fit.idealUnits > b.units && ep.deltaUnits > 0);
  const m = meanOf(ratios);
  assert.ok(m >= 1.3 && m <= 1.55, `mean idealUnits/units ${m.toFixed(2)}`);
});

const simFat = simulatePatient({ days: 60, seed: 1, fatMeals: { rate: 0.3, fat: 40, delayMin: 60, durationMin: 300 } });
const simFatEnd = simFat.glucoseHistory[simFat.glucoseHistory.length - 1].time;

test('high-fat meal peaks late -> delayedRise', () => {
  const P = E.prepareLearningInput({ ...simInput(simFat), macroMealLog: simFat.macroMealLog });
  const fatTimes = new Set(simFat.truth.fatMeals.map(m => m.time));
  const underdosed = new Set(simFat.truth.underdosedMeals.map(m => m.time));
  // well-dosed meals (no deliberate under-dose), nothing unlogged/stacked/missing in the window
  const usable = loggedMeals(simFat).filter(b => !underdosed.has(b.time) &&
    !simFat.truth.snacks.some(s => s.time > b.time - 3 * H && s.time < b.time + 5 * H) &&
    !inBoost(simFat, b.time, b.time + 5 * H))
    .map(b => ({ b, ep: E.scoreMealEpisode(P, b, mealOpts(simFat, simFatEnd)) }))
    .filter(({ ep }) => ep && !['stacked-meal', 'sensor-gap', 'too-few-readings', 'compression-low'].includes(ep.confounded));
  const fat = usable.filter(({ b }) => fatTimes.has(b.time)), plain = usable.filter(({ b }) => !fatTimes.has(b.time));
  assert.ok(fat.length >= 5 && plain.length >= 10, `fat ${fat.length}, plain ${plain.length}`);
  const fatLate = fat.filter(({ ep }) => ep.delayedRise).length, plainLate = plain.filter(({ ep }) => ep.delayedRise).length;
  console.log(`delayedRise: fat ${fatLate}/${fat.length} (peaks ${fat.map(x => x.ep.fit.peakMin).join(',')}), plain ${plainLate}/${plain.length}`);
  assert.ok(fatLate / fat.length >= 0.8, `fat meals flagged ${fatLate}/${fat.length}`);
  assert.ok(plainLate / plain.length <= 0.2, `plain meals flagged ${plainLate}/${plain.length}`);
  for (const { ep } of fat) assert.deepStrictEqual(ep.macros, { fat: 40, protein: ep.macros.protein });
  for (const { ep } of fat) assert.strictEqual(ep.delayedRise, ep.fit.peakMin > 150);
});

test('meal episode: null until elapsed, stacked-meal, missing profile, macros null without a log', () => {
  const cleanMealEpisodes = meals60().clean;
  const b = cleanMealEpisodes[0].b;
  assert.strictEqual(E.scoreMealEpisode(P60, b, mealOpts(sim60, b.time + 299 * 60000)), null);
  assert.ok(E.scoreMealEpisode(P60, b, mealOpts(sim60, b.time + 300 * 60000)));
  assert.strictEqual(cleanMealEpisodes[0].ep.macros, null);
  // a second carb bolus 60 min later -> stacked
  const extra = { time: b.time + 60 * 60000, units: 1, carbs: 20 };
  const stacked = E.scoreMealEpisode({ ...simInput(sim60), boluses: [...sim60.boluses, extra] }, b, mealOpts(sim60, simEnd));
  assert.strictEqual(stacked.confounded, 'stacked-meal');
  // no ISF and no profile -> missing-profile, no fitted CR
  const ep = E.scoreMealEpisode(P60, b, { nowMs: simEnd });
  assert.strictEqual(ep.confounded, 'missing-profile');
  assert.strictEqual(ep.fit.carbRatio, null);
  assert.strictEqual(ep.fit.idealUnits, null);
  const noIsf = E.scoreMealEpisode(P60, b, { pumpProfile: sim60.pumpProfile, isfAt: () => NaN, nowMs: simEnd });
  assert.strictEqual(noIsf.confounded, 'missing-profile');
  // the auto flag is never learned from; no carbs -> not a meal
  assert.strictEqual(E.scoreMealEpisode(P60, { ...b, auto: true }, mealOpts(sim60, simEnd)).confounded, 'auto-bolus');
  assert.strictEqual(E.scoreMealEpisode(P60, { ...b, carbs: 0 }, mealOpts(sim60, simEnd)), null);
});

test('meal fits never carry an implausible CR when clean (seeds 1-7 x 90 days)', () => {
  let clean = 0, implausible = 0;
  for (const p of sim90) {
    const P = E.prepareLearningInput(simInput(p));
    const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
    for (const b of loggedMeals(p)) {
      const ep = E.scoreMealEpisode(P, b, mealOpts(p, nowMs));
      if (!ep) continue;
      if (ep.confounded === 'implausible-fit') implausible++;
      if (ep.confounded !== null) continue;
      clean++;
      assert.ok(ep.fit.carbRatio >= 2 && ep.fit.carbRatio <= 60, `clean meal with CR ${ep.fit.carbRatio}`);
    }
  }
  console.log(`meals seeds 1-7 x 90d: ${clean} clean, ${implausible} implausible-fit`);
  assert.ok(clean > 300);
});
