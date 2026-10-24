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

let _fat = null;   // simFat meals scored lazily, once
function fatMeals() {
  if (!_fat) {
    const P = E.prepareLearningInput({ ...simInput(simFat), macroMealLog: simFat.macroMealLog });
    const fatTimes = new Set(simFat.truth.fatMeals.map(m => m.time));
    const all = loggedMeals(simFat).map(b => ({ b, fat: fatTimes.has(b.time), ep: E.scoreMealEpisode(P, b, mealOpts(simFat, simFatEnd)) }))
      .filter(x => x.ep);
    _fat = { P, all };
  }
  return _fat;
}
const countBy = xs => xs.reduce((o, { ep }) => { o[ep.confounded] = (o[ep.confounded] || 0) + 1; return o; }, {});
// windows the learner can't use for anything regardless of fat
const unusable = ep => ['stacked-meal', 'sensor-gap', 'too-few-readings', 'compression-low'].includes(ep.confounded);

test('high-fat meal peaks late -> late-absorption with delayedRise', () => {
  const { all } = fatMeals();
  const fat = all.filter(x => x.fat && !unusable(x.ep));
  assert.ok(fat.length >= 20, `only ${fat.length} usable fat meals`);
  const late = fat.filter(({ ep }) => ep.confounded === 'late-absorption');
  console.log(`fat meals (40 g): ${JSON.stringify(countBy(fat))}; slow fits ${late.slice(0, 8).map(({ ep }) => `${ep.fit.slowAbsorption.delayMin}+${ep.fit.slowAbsorption.durationMin}`).join(' ')}`);
  assert.ok(late.length / fat.length >= 0.8, `late-absorption ${late.length}/${fat.length}`);
  for (const { ep } of late) {
    assert.strictEqual(ep.delayedRise, true);
    assert.ok(ep.macros.fat >= 20);
    assert.ok(ep.fit.slowAbsorption && ep.fit.slowAbsorption.carbRatio >= 2 && ep.fit.slowAbsorption.carbRatio <= 60);
  }
  // one 40 g-fat meal on its own
  const one = late[0];
  assert.deepStrictEqual(one.ep.macros, { fat: 40, protein: one.ep.macros.protein });
  assert.strictEqual(one.ep.confounded, 'late-absorption');
  assert.strictEqual(one.ep.delayedRise, true);
});

test('late-absorption never on low-fat or unlogged-macro meals; snacks stay unexplained-rise', () => {
  const { all } = fatMeals();
  const plain = all.filter(x => !x.fat);
  assert.ok(plain.length > 50);
  assert.strictEqual(plain.filter(({ ep }) => ep.confounded === 'late-absorption').length, 0);
  for (const { ep } of plain) assert.ok(ep.macros && ep.macros.fat < 20);
  const snacked = plain.filter(({ b }) => simFat.truth.snacks.some(s => s.time >= b.time - 60 * 60000 && s.time <= b.time + 240 * 60000));
  assert.ok(snacked.length >= 5, `only ${snacked.length} snack-overlapping plain meals`);
  console.log(`snack-overlapping plain meals: ${JSON.stringify(countBy(snacked))}`);
  // no macro log at all (default sim) -> never late-absorption
  assert.strictEqual(meals60().all.filter(({ ep }) => ep && ep.confounded === 'late-absorption').length, 0);
});

test('late-absorption episodes are not clean, so CR learning ignores them', () => {
  const { all } = fatMeals();
  const late = all.filter(({ ep }) => ep.confounded === 'late-absorption');
  assert.ok(late.length > 0);
  for (const { ep } of late) assert.notStrictEqual(ep.confounded, null);
  // CR learning set (confounded === null) holds no fat meal that the slow-curve explained
  const clean = all.filter(({ ep }) => ep.confounded === null);
  assert.ok(clean.length >= 40);
  assert.strictEqual(clean.filter(({ ep }) => ep.fit.slowAbsorption).length, 0);
});

test('delayedRise follows the unexplained late rise, not the raw peak', () => {
  const { all } = fatMeals();
  // clean plain meals, incl. under-dosed ones (they peak late on raw glucose, but the fit explains it)
  const plainClean = all.filter(x => !x.fat && x.ep.confounded === null && !inBoost(simFat, x.b.time, x.b.time + 5 * H));
  const underdosed = new Set(simFat.truth.underdosedMeals.map(m => m.time));
  const rawLate = plainClean.filter(({ ep }) => ep.fit.peakMin > 150).length;
  const flagged = plainClean.filter(({ ep }) => ep.delayedRise).length;
  console.log(`clean plain meals n=${plainClean.length} (under-dosed ${plainClean.filter(x => underdosed.has(x.b.time)).length}): raw peak > 150 min ${rawLate}, delayedRise ${flagged}`);
  assert.ok(plainClean.length >= 40);
  assert.ok(flagged / plainClean.length <= 0.05, `plain meals flagged ${flagged}/${plainClean.length}`);
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

/* ── Task 5: exercise episodes and nights ───────────────────────────── */
const RUN = { dropPerMin: 0.045, sensitivityBoost: 1.2, hours: 24 };
const RUN_EXERCISE = { Running: RUN, Weights: { dropPerMin: 0.015, sensitivityBoost: 1.15, hours: 16 } };
const runOpts = (p, nowMs) => ({ pumpProfile: p.pumpProfile, isfAt: ms => p.truth.isfByHour(londonHour(ms)), nowMs });
const boostEnd = (p, w) => w.endTime + p.truth.exercise[w.workoutType].hours * H;

// Seeds 1-7 x 90 days pooled (as the meal tests do): a single seed has only ~5-16 clean runs and
// ~6-11 clean after-run nights, so its mean swings with which unlogged snacks happen to land
// before a window. Scored lazily, once.
let _ex = null;
function exercisePooled() {
  if (!_ex) {
    const workouts = [], nights = [], perSeed = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const p = simulatePatient({ days: 90, seed, exercise: RUN_EXERCISE });
      const P = E.prepareLearningInput(simInput(p));
      const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
      const ws = p.activities.workouts.map(w => ({ seed, p, P, w, ep: E.scoreExerciseEpisode(P, w, runOpts(p, nowMs)) }));
      const ns = [];
      // one night per London date: 00:00 London of each sim day
      for (let t = p.glucoseHistory[0].time; t < nowMs; t += 24 * H) {
        const ep = E.scoreNight(P, t + 12 * H, runOpts(p, nowMs));
        if (!ep) continue;
        const nightEnd = ep.startMs + 6 * H;
        const afterRun = p.activities.workouts.some(w => w.workoutType === 'Running' && w.endTime <= ep.startMs && boostEnd(p, w) >= nightEnd);
        const without = !p.activities.workouts.some(w => w.startTime < nightEnd && (w.startTime > ep.startMs - 30 * H || boostEnd(p, w) > ep.startMs));
        ns.push({ seed, ep, afterRun, without });
      }
      workouts.push(...ws); nights.push(...ns);
      perSeed.push({ seed, p, P, nowMs });
    }
    _ex = { workouts, nights, perSeed };
  }
  return _ex;
}
const bySeed = (xs, f) => [1, 2, 3, 4, 5, 6, 7].map(seed => { const v = xs.filter(x => x.seed === seed).map(f); return v.length ? `${seed}:${meanOf(v).toFixed(3)}(n=${v.length})` : `${seed}:-`; }).join(' ');

test('exercise episode: running drop recovered within 30% of truth', () => {
  const { workouts } = exercisePooled();
  const runs = workouts.filter(({ w }) => w.workoutType === 'Running');
  const clean = runs.filter(({ ep }) => ep && ep.confounded === null);
  console.log(`runs ${runs.length}: clean ${clean.length}; confounded ${JSON.stringify(countBy(runs.filter(x => x.ep && x.ep.confounded)))}; per seed ${bySeed(clean, ({ ep }) => ep.fit.dropPerMin)}`);
  assert.ok(clean.length >= 40, `only ${clean.length} clean runs`);
  const m = meanOf(clean.map(({ ep }) => ep.fit.dropPerMin));
  console.log(`pooled mean running dropPerMin ${m.toFixed(4)} vs truth ${RUN.dropPerMin}`);
  assert.ok(Math.abs(m - RUN.dropPerMin) / RUN.dropPerMin <= 0.3, `mean dropPerMin ${m}`);
  for (const { w, ep } of clean) {
    assert.strictEqual(ep.kind, 'exercise');
    assert.strictEqual(ep.workoutType, 'Running');
    assert.strictEqual(ep.intensity, 'cardio-endurance');
    assert.strictEqual(ep.minutes, (w.endTime - w.startTime) / 60000);
    assert.ok(Number.isFinite(ep.fit.rmse) && ep.fit.n > 0);
  }
  // weights (truth 0.015) drop less than runs
  const weights = workouts.filter(({ w, ep }) => w.workoutType === 'Weights' && ep && ep.confounded === null);
  if (weights.length >= 5) assert.ok(meanOf(weights.map(({ ep }) => ep.fit.dropPerMin)) < m);
});

test('night after a run is more insulin-sensitive than a night without exercise', () => {
  const { nights } = exercisePooled();
  const clean = nights.filter(n => n.ep.confounded === null);
  const after = clean.filter(n => n.afterRun), without = clean.filter(n => n.without);
  const conf = {};
  for (const n of nights) if (n.ep.confounded) conf[n.ep.confounded] = (conf[n.ep.confounded] || 0) + 1;
  const mA = meanOf(after.map(n => n.ep.fit.isfRatio)), mW = meanOf(without.map(n => n.ep.fit.isfRatio));
  console.log(`nights ${nights.length}: clean ${clean.length}, confounded ${JSON.stringify(conf)}; after run n=${after.length} isfRatio ${mA.toFixed(3)}; without n=${without.length} isfRatio ${mW.toFixed(3)}; drift without ${meanOf(without.map(n => n.ep.fit.driftPerHr)).toFixed(3)}/h`);
  console.log(`  after per seed ${bySeed(after, n => n.ep.fit.isfRatio)}; without per seed ${bySeed(without, n => n.ep.fit.isfRatio)}`);
  assert.ok(after.length >= 30, `only ${after.length} clean nights after a run`);
  assert.ok(without.length >= 100, `only ${without.length} clean nights without exercise`);
  assert.ok(mA >= 1.08 && mA <= 1.35, `after-run isfRatio ${mA}`);
  assert.ok(mW >= 0.9 && mW <= 1.1, `no-exercise isfRatio ${mW}`);
  // a night whose logged insulin barely moves glucose can't determine a ratio
  const weak = nights.filter(n => n.ep.confounded === 'weak-signal');
  assert.ok(weak.length > 0);
  for (const n of weak) assert.ok(n.ep.fit.insulinMmol < 1);
  for (const n of clean) assert.ok(n.ep.fit.insulinMmol >= 1 && n.ep.fit.isfRatio >= 0.3 && n.ep.fit.isfRatio <= 3);
  for (const n of after) {
    assert.strictEqual(n.ep.kind, 'night');
    assert.ok(n.ep.context.exercise24h.types.includes('Running'));
    assert.ok(Number.isFinite(n.ep.fit.driftPerHr));
  }
});

test('exercise + night episodes: null until elapsed, missing profile, London 00-06 across DST', () => {
  const { workouts, perSeed } = exercisePooled();
  const { p: simRun, P, nowMs: simRunEnd } = perSeed[0];
  const w = workouts.find(x => x.seed === 1 && x.ep && x.ep.confounded === null).w;
  const end = w.endTime + 60 * 60000;
  assert.strictEqual(E.scoreExerciseEpisode(P, w, runOpts(simRun, end - 60000)), null);
  assert.ok(E.scoreExerciseEpisode(P, w, runOpts(simRun, end)));
  assert.ok(E.scoreExerciseEpisode(P, { ...w, startTime: new Date(w.startTime).toISOString(), endTime: new Date(w.endTime).toISOString() }, runOpts(simRun, end)));
  assert.strictEqual(E.scoreExerciseEpisode(P, w, { nowMs: simRunEnd }).confounded, 'missing-profile');
  assert.strictEqual(E.scoreExerciseEpisode(P, w, { pumpProfile: simRun.pumpProfile, isfAt: () => NaN, nowMs: simRunEnd }).confounded, 'missing-profile');

  const night = Date.UTC(2026, 1, 10, 0);   // 00:00 London (GMT)
  assert.strictEqual(E.scoreNight(P, night, runOpts(simRun, night + 6 * H - 60000)), null);
  const ep = E.scoreNight(P, night, runOpts(simRun, night + 6 * H));
  assert.strictEqual(ep.kind, 'night');
  assert.strictEqual(ep.startMs, night);
  assert.strictEqual(ep.endMs, night + 6 * H);
  assert.strictEqual(E.scoreNight(P, night, { nowMs: simRunEnd }).confounded, 'missing-profile');
  assert.ok(ep.context.exercise24h && Array.isArray(ep.context.exercise24h.types));
  // BST: 00:00 London = 23:00 UTC the day before; any time on that London date picks the same night
  const summer = E.scoreNight({ glucoseHistory: [] }, Date.UTC(2026, 6, 15, 14), { nowMs: Date.UTC(2026, 7, 1) });
  assert.strictEqual(summer.startMs, Date.UTC(2026, 6, 14, 23));
  assert.strictEqual(summer.endMs, Date.UTC(2026, 6, 15, 5));
  // clocks change inside the window: spring 5h, autumn 7h
  const spring = E.scoreNight({ glucoseHistory: [] }, Date.UTC(2026, 2, 29, 12), { nowMs: Date.UTC(2026, 4, 1) });
  assert.strictEqual(spring.endMs - spring.startMs, 5 * H);
  const autumn = E.scoreNight({ glucoseHistory: [] }, Date.UTC(2026, 9, 25, 12), { nowMs: Date.UTC(2026, 11, 1) });
  assert.strictEqual(autumn.startMs, Date.UTC(2026, 9, 24, 23));
  assert.strictEqual(autumn.endMs - autumn.startMs, 7 * H);
});

test('night with complete CGM but no logged insulin -> weak-signal, not sensor-gap', () => {
  const start = Date.UTC(2026, 1, 10, 0);   // 00:00 London (GMT)
  const glucoseHistory = [];
  for (let t = start - 3 * H; t <= start + 6 * H; t += 5 * 60000) glucoseHistory.push({ time: t, value: 6.5 + 0.2 * Math.sin(t / H) });
  const profile = { default: [{ time: '00:00', correctionFactor: 3, carbRatio: 10, basalRate: 0.8 }] };
  const ep = E.scoreNight({ glucoseHistory }, start, { pumpProfile: profile, nowMs: start + 7 * H });
  assert.ok(ep.fit.n >= 72, `n ${ep.fit.n}`);
  assert.strictEqual(ep.fit.insulinMmol, 0);
  assert.strictEqual(ep.confounded, 'weak-signal');
  // a real gap still wins
  const gappy = { glucoseHistory: glucoseHistory.filter(r => r.time < start + 2 * H || r.time > start + 3 * H) };
  assert.strictEqual(E.scoreNight(gappy, start, { pumpProfile: profile, nowMs: start + 7 * H }).confounded, 'sensor-gap');
});

/* ── Task 6: fitModel ──────────────────────────────────────────────── */
const D = 24 * H;
const FLAT = { default: [{ time: '00:00', correctionFactor: 3, carbRatio: 10, basalRate: 0.8 }] };
const AT10 = Date.UTC(2026, 0, 6, 10);   // 10:00 London (GMT) -> block 09:00-12:00
const noEx = { minutes: 0, types: [], trimp: null };
const ctx = (extra = {}) => ({ exercise24h: noEx, exercise48h: noEx, siteAgeHours: null, rhrZ: null, sleepHrs: null, ...extra });
const corrEp = (startMs, isf, c = {}, confounded = null) => ({ kind: 'correction', startMs, units: 1, context: ctx(c), fit: { isf }, confounded });
const mealEp = (startMs, carbRatio, extra = {}) => ({ kind: 'meal', startMs, carbs: 40, units: 4, context: ctx(), fit: { carbRatio },
  macros: null, delayedRise: false, confounded: null, ...extra });
const exEp = (workoutType, dropPerMin, confounded = null) => ({ kind: 'exercise', startMs: AT10, workoutType, context: ctx(), fit: { dropPerMin }, confounded });
const nightEp = (startMs, isfRatio, exercised) => ({ kind: 'night', startMs,
  context: ctx({ exercise24h: exercised ? { minutes: 45, types: ['Running'], trimp: null } : noEx }), fit: { isfRatio }, confounded: null });
const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const block = (m, label) => m.blocks.find(b => b.label === label);

test('fitModel: shape, 8 blocks with pump values, JSON-serialisable and deterministic', () => {
  const eps = [...many(12, i => corrEp(AT10 + i * 60000, 3.3)), ...many(12, i => mealEp(AT10 + i * 60000, 11))];
  const m = E.fitModel(eps, FLAT, { nowMs: AT10 });
  assert.strictEqual(m.version, 2);
  assert.strictEqual(m.fittedAt, AT10);
  assert.deepStrictEqual(m.blocks.map(b => [b.label, b.from, b.to]),
    [['00:00–03:00', 0, 3], ['03:00–06:00', 3, 6], ['06:00–09:00', 6, 9], ['09:00–12:00', 9, 12],
      ['12:00–15:00', 12, 15], ['15:00–18:00', 15, 18], ['18:00–21:00', 18, 21], ['21:00–24:00', 21, 24]]);
  for (const b of m.blocks) { assert.strictEqual(b.isf.pump, 3); assert.strictEqual(b.carbRatio.pump, 10); }
  const b = block(m, '09:00–12:00');
  assert.strictEqual(b.isf.source, 'learned'); assert.ok(Math.abs(b.isf.value - 3.3) < 1e-9); assert.strictEqual(b.isf.n, 12);
  assert.strictEqual(b.carbRatio.source, 'learned'); assert.ok(Math.abs(b.carbRatio.value - 11) < 1e-9);
  assert.strictEqual(m.allDay.nIsf, 12); assert.strictEqual(m.allDay.nCr, 12);
  assert.deepStrictEqual(m.forecastBias, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m)), m);
  assert.deepStrictEqual(E.fitModel(eps, FLAT, { nowMs: AT10 }), m);
  // confounded episodes never count
  const dirty = E.fitModel(many(12, i => corrEp(AT10 + i, 2.4, {}, 'unexplained-rise')), FLAT, { nowMs: AT10 });
  assert.strictEqual(block(dirty, '09:00–12:00').isf.n, 0);
  assert.strictEqual(block(dirty, '09:00–12:00').isf.value, 3);
  assert.strictEqual(block(dirty, '09:00–12:00').isf.source, 'pump');
  // no pump profile -> nothing to guard-band against -> no values
  const none = E.fitModel(eps, null, { nowMs: AT10 });
  assert.strictEqual(block(none, '09:00–12:00').isf.value, null);
  assert.strictEqual(block(none, '09:00–12:00').isf.source, 'pump');
});

test('less insulin usable at n=5; more insulin needs n=10', () => {
  const fit = eps => block(E.fitModel(eps, FLAT, { nowMs: AT10 }), '09:00–12:00');
  // ISF 30% below pump = more insulin: 6 is not enough, block and all-day alike
  const more6 = fit(many(6, i => corrEp(AT10 + i * 60000, 2.1 + 1e-9)));
  assert.notStrictEqual(more6.isf.source, 'learned');
  assert.strictEqual(more6.isf.source, 'pump');
  assert.strictEqual(more6.isf.value, 3);
  // ISF 20% above pump = less insulin: 6 is enough
  const less6 = fit(many(6, i => corrEp(AT10 + i * 60000, 3.6)));
  assert.strictEqual(less6.isf.source, 'learned');
  assert.ok(Math.abs(less6.isf.value - 3.6) < 1e-9);
  assert.strictEqual(fit(many(4, i => corrEp(AT10 + i * 60000, 3.6))).isf.source, 'pump');
  assert.strictEqual(fit(many(5, i => corrEp(AT10 + i * 60000, 3.6))).isf.source, 'learned');
  // more insulin at n=10 is learned
  const more10 = fit(many(10, i => corrEp(AT10 + i * 60000, 2.4)));
  assert.strictEqual(more10.isf.source, 'learned');
  assert.ok(Math.abs(more10.isf.value - 2.4) < 1e-9);
  // carb ratio: lower CR = more insulin
  assert.strictEqual(fit(many(6, i => mealEp(AT10 + i * 60000, 8))).carbRatio.source, 'pump');
  assert.strictEqual(fit(many(6, i => mealEp(AT10 + i * 60000, 12))).carbRatio.source, 'learned');
  // pooled: 6 + 6 more-insulin episodes in two blocks -> neither block alone, but all-day (n=12) is usable
  const m = E.fitModel([...many(6, i => corrEp(AT10 + i * 60000, 2.4)), ...many(6, i => corrEp(AT10 + 6 * H + i * 60000, 2.4))], FLAT, { nowMs: AT10 + D });
  for (const label of ['09:00–12:00', '15:00–18:00']) {
    assert.strictEqual(block(m, label).isf.source, 'pooled');
    assert.ok(Math.abs(block(m, label).isf.value - 2.4) < 1e-9);
  }
  // blocks with no episodes take the pooled value too
  assert.strictEqual(block(m, '00:00–03:00').isf.source, 'pooled');
});

test('guard band clamps and flags', () => {
  const m = E.fitModel([...many(10, i => corrEp(AT10 + i * 60000, 6)), ...many(10, i => mealEp(AT10 + i * 60000, 4))], FLAT, { nowMs: AT10 });
  const b = block(m, '09:00–12:00');
  assert.ok(Math.abs(b.isf.value - 1.3 * 3) < 1e-9, `isf ${b.isf.value}`);
  assert.strictEqual(b.isf.outsideBand, true);
  assert.ok(Math.abs(b.carbRatio.value - 0.7 * 10) < 1e-9, `cr ${b.carbRatio.value}`);
  assert.strictEqual(b.carbRatio.outsideBand, true);
  const inBand = block(E.fitModel(many(10, i => corrEp(AT10 + i * 60000, 3.3)), FLAT, { nowMs: AT10 }), '09:00–12:00');
  assert.strictEqual(inBand.isf.outsideBand, false);
  // every block of every model stays inside the band
  for (const bb of m.blocks) for (const k of ['isf', 'carbRatio']) {
    assert.ok(bb[k].value >= 0.7 * bb[k].pump - 1e-9 && bb[k].value <= 1.3 * bb[k].pump + 1e-9);
  }
});

test('rate limit 10%/day', () => {
  const profile = { default: [{ time: '00:00', correctionFactor: 3.5, carbRatio: 10, basalRate: 0.8 }] };
  const prev = E.fitModel(many(10, i => corrEp(AT10 + i * 60000, 3.0)), profile, { nowMs: AT10 });
  assert.ok(Math.abs(block(prev, '09:00–12:00').isf.value - 3.0) < 1e-9);
  const later = (days, isf) => block(E.fitModel(many(10, i => corrEp(AT10 + days * D + i * 60000, isf)), profile,
    { nowMs: AT10 + days * D, prevModel: JSON.parse(JSON.stringify(prev)) }), '09:00–12:00').isf.value;
  const up = later(1, 4.0);
  assert.ok(up <= 3.3 + 1e-9, `value ${up}`);
  assert.ok(up >= 3.3 - 1e-9, `cap applied, not reset: ${up}`);
  assert.ok(Math.abs(later(0.5, 4.0) - 3.15) < 1e-9);
  assert.ok(Math.abs(later(1, 2.5) - 2.7) < 1e-9);
  assert.ok(Math.abs(later(10, 4.0) - 4.0) < 1e-9);   // 10 days: cap 100%, evidence wins
});

test('exercise boost never below 1', () => {
  const night = i => Date.UTC(2026, 0, 6 + i, 0);
  const boost = (nA, rA, nW, rW) => E.fitModel([...many(nA, i => nightEp(night(i), rA, true)), ...many(nW, i => nightEp(night(i + 20), rW, false))],
    FLAT, { nowMs: night(40) }).exercise.boost;
  assert.strictEqual(boost(6, 0.8, 6, 1.0).multiplier, 1);
  assert.ok(Math.abs(boost(6, 1.3, 6, 1.0).multiplier - 1.3) < 1e-9);
  assert.strictEqual(boost(4, 1.3, 6, 1.0).multiplier, 1);   // n >= 5 each side
  assert.strictEqual(boost(6, 1.3, 4, 1.0).multiplier, 1);
  assert.strictEqual(boost(6, 1.3, 6, 1.0).hours, 24);
  assert.strictEqual(boost(6, 1.3, 6, 1.0).n, 6);
  // per type: n >= 3 to report, robust to one outlier, never a rise
  const ex = E.fitModel([...many(4, i => exEp('Running', [0.04, 0.05, 0.045, 0.3][i])), ...many(3, () => exEp('Yoga', -0.02)),
    ...many(2, () => exEp('Swim', 0.05)), ...many(5, () => exEp('Golf', 0.05, 'carbs-in-window'))], FLAT, { nowMs: AT10 }).exercise;
  assert.ok(Math.abs(ex.Running.dropPerMin - 0.0475) < 1e-9);
  assert.strictEqual(ex.Running.n, 4);
  assert.strictEqual(ex.Yoga.dropPerMin, 0);
  assert.strictEqual(ex.Swim, undefined);
  assert.strictEqual(ex.Golf, undefined);
});

test('modifier stays off without evidence', () => {
  const t = i => AT10 + i * 60000;
  const noise = i => (i % 2 ? 0.1 : -0.1);
  const mods = eps => E.fitModel(eps, FLAT, { nowMs: t(100) }).modifiers;
  const off = mods([...many(4, i => corrEp(t(i), 2.0, { siteAgeHours: 72 })), ...many(20, i => corrEp(t(10 + i), 3.0 + noise(i), { siteAgeHours: 12 }))]);
  assert.strictEqual(off.siteAge.active, false);
  assert.strictEqual(off.siteAge.effect, 1);
  assert.strictEqual(off.siteAge.n, 4);
  assert.strictEqual(off.illness.active, false);
  assert.strictEqual(off.shortSleep.active, false);
  // with >= 10 each side and a clear difference it switches on: effect = ISF with / without
  const on = mods([...many(12, i => corrEp(t(i), 2.0 + noise(i), { siteAgeHours: 72 })),
    ...many(12, i => corrEp(t(20 + i), 3.0 + noise(i), { siteAgeHours: 12 }))]);
  assert.strictEqual(on.siteAge.active, true);
  assert.ok(Math.abs(on.siteAge.effect - 2 / 3) < 1e-9, `effect ${on.siteAge.effect}`);
  assert.strictEqual(on.siteAge.n, 12);
  // >= 10 each side but no real difference -> off
  const flat = mods([...many(12, i => corrEp(t(i), 3.0 + noise(i), { rhrZ: 2 })), ...many(12, i => corrEp(t(20 + i), 3.0 - noise(i), { rhrZ: 0 }))]);
  assert.strictEqual(flat.illness.active, false);
  const sleep = mods([...many(12, i => corrEp(t(i), 3.6 + noise(i), { sleepHrs: 5 })), ...many(12, i => corrEp(t(20 + i), 3.0 + noise(i), { sleepHrs: 8 }))]);
  assert.strictEqual(sleep.shortSleep.active, true);
  assert.ok(Math.abs(sleep.shortSleep.effect - 1.2) < 1e-9);
});

test('meal delayed-rise rates: high fat vs other, clean or late-absorption only', () => {
  const t = i => AT10 + i * 60000;
  const m = E.fitModel([
    ...many(3, i => mealEp(t(i), 10, { macros: { fat: 40, protein: 20 }, delayedRise: true, confounded: 'late-absorption' })),
    mealEp(t(3), 10, { macros: { fat: 25, protein: 20 } }),
    mealEp(t(4), 10, { macros: { fat: 5, protein: 20 }, delayedRise: true }),
    ...many(3, i => mealEp(t(5 + i), 10, { macros: { fat: 5, protein: 20 } })),
    ...many(4, i => mealEp(t(8 + i), 10)),                                                          // no macro log -> other
    ...many(5, i => mealEp(t(12 + i), 10, { delayedRise: true, confounded: 'unexplained-rise' })),   // never counted
  ], FLAT, { nowMs: t(20) });
  assert.deepStrictEqual(m.meals.delayedRiseHighFat, { rate: 0.75, n: 4 });
  assert.deepStrictEqual(m.meals.delayedRiseOther, { rate: 1 / 8, n: 8 });
  // late-absorption meals still never feed the carb ratio
  assert.strictEqual(block(m, '09:00–12:00').carbRatio.n, 9);
});

test('episodes bucket by London start hour across the clock change', () => {
  // 00:30Z on 25 Oct is still BST (01:30 London; clocks go back at 01:00Z); 23:30Z on 24 Oct = 00:30 BST
  const gmt = Date.parse('2026-10-25T00:30:00Z'), bst = Date.parse('2026-10-24T23:30:00Z');
  const m = E.fitModel([corrEp(gmt, 3.3), corrEp(bst, 3.3), mealEp(gmt, 11), mealEp(bst, 11)], FLAT, { nowMs: gmt });
  assert.strictEqual(block(m, '00:00–03:00').isf.n, 2);
  assert.strictEqual(block(m, '00:00–03:00').carbRatio.n, 2);
  assert.strictEqual(block(m, '21:00–24:00').isf.n, 0);
  // and after the change: 00:30Z on 26 Oct = 00:30 GMT
  const after = E.fitModel([corrEp(Date.parse('2026-10-26T00:30:00Z'), 3.3)], FLAT, { nowMs: gmt + 2 * D });
  assert.strictEqual(block(after, '00:00–03:00').isf.n, 1);
});

test('time decay: old evidence weighs less', () => {
  const now = AT10 + 120 * D;
  const m = E.fitModel([...many(10, i => corrEp(AT10 + i * 60000, 3.6)), ...many(10, i => corrEp(now - i * 60000, 3.0))], FLAT, { nowMs: now });
  const v = block(m, '09:00–12:00').isf.value;
  assert.ok(v > 3.0 && v < 3.05, `value ${v}`);   // 120-day-old episodes weigh 1/16
});

// Seeds 1-7 x 90 days pooled (one seed has only ~5-15 clean corrections per block), scored lazily, once.
let _corr90 = null;
function corrections90() {
  if (!_corr90) {
    _corr90 = [];
    for (const p of sim90) {
      const P = E.prepareLearningInput(simInput(p));
      const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
      for (const c of p.corrections) {
        const ep = E.scoreCorrectionEpisode(P, c, { pumpProfile: p.pumpProfile, nowMs });
        if (ep) _corr90.push(ep);
      }
    }
  }
  return _corr90;
}

test('learns time-of-day ISF from the sim', () => {
  const p = sim90[0];
  const nowMs = p.glucoseHistory[p.glucoseHistory.length - 1].time;
  const m = E.fitModel(corrections90(), p.pumpProfile, { nowMs });
  // Truth = the block's hour-averaged ISF. It equals isfByHour(block midpoint) except where the sim's
  // truth steps inside a block (04:00 in 03-06, 17:00 in 15-18): 03-06's midpoint (4.5h -> 2.2) is not
  // its truth when hour 3 runs at 3.2 (learned 2.65 = 20.7% off the midpoint, 4.6% off the block mean).
  const rows = m.blocks.map(b => {
    const hrs = Array.from({ length: b.to - b.from }, (_, i) => b.from + i);
    const truth = meanOf(hrs.map(h => p.truth.isfByHour(h))), mid = p.truth.isfByHour((b.from + b.to) / 2);
    return { label: b.label, n: b.isf.n, source: b.isf.source, value: b.isf.value, truth, mid, err: (b.isf.value - truth) / truth };
  });
  console.log('fitModel ISF per block: ' + rows.map(r => `${r.label} n=${r.n} ${r.source} ${r.value.toFixed(2)} (truth ${r.truth.toFixed(2)} ${(r.err * 100).toFixed(1)}%; midpoint ${r.mid} ${((r.value - r.mid) / r.mid * 100).toFixed(1)}%)`).join('; '));
  const tested = rows.filter(r => r.n >= 10);
  assert.strictEqual(tested.length, 8, `only ${tested.length} blocks with n >= 10`);
  for (const r of tested) {
    assert.strictEqual(r.source, 'learned');
    assert.ok(Math.abs(r.err) <= 0.2, `${r.label}: ${r.value.toFixed(2)} vs truth ${r.truth} (${(r.err * 100).toFixed(1)}%)`);
  }
});
