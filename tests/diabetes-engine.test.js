// Guards the parts of the diabetes engine that turn into an insulin
// number on screen. Fixed inputs, expected outputs — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/diabetes-engine.js');

const NOW = Date.parse('2026-07-01T12:00:00Z');
const minsAgo = m => new Date(NOW - m * 60000).toISOString();
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('insulin on board: full at dose time, gone at duration, decreasing between', () => {
  close(E.iobFraction(0), 1);
  close(E.iobFraction(E.IOB_DURATION_MINUTES), 0);
  let prev = 1;
  for (let t = 15; t < E.IOB_DURATION_MINUTES; t += 15) {
    const f = E.iobFraction(t);
    assert.ok(f < prev && f > 0, `iobFraction(${t}) = ${f} not strictly decreasing in (0,1)`);
    prev = f;
  }
});

test('carbs on board: full at meal time, gone at duration, decreasing between', () => {
  close(E.cobFraction(0), 1);
  close(E.cobFraction(E.COB_DURATION_MINUTES), 0);
  assert.ok(E.cobFraction(E.COB_DURATION_MINUTES / 2) < 1);
  assert.ok(E.cobFraction(E.COB_DURATION_MINUTES / 2) > 0);
});

test('activeInsulin ignores carb-only rows and future doses, scales by units', () => {
  const boluses = [
    { time: minsAgo(60), units: 2 },
    { time: minsAgo(30), units: 0, carbs: 40 },  // carbs only
    { time: new Date(NOW + 10 * 60000).toISOString(), units: 5 }, // future
  ];
  close(E.activeInsulin(boluses, [], NOW), 2 * E.iobFraction(60));
  close(E.activeInsulin([], [{ time: minsAgo(0), units: 3 }], NOW), 3);
});

test('carbsOnBoard counts carb-only rows', () => {
  close(E.carbsOnBoard([{ time: minsAgo(30), units: 0, carbs: 40 }], NOW), 40 * E.cobFraction(30));
});

test('dosingContext marks a reading older than the stale limit as stale', () => {
  const fresh = E.dosingContext({ glucoseHistory: [{ time: minsAgo(5), value: 9 }] }, NOW);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.currentGlucose, 9);
  const old = E.dosingContext({ glucoseHistory: [{ time: minsAgo(E.STALE_READING_MINUTES + 1), value: 9 }] }, NOW);
  assert.equal(old.stale, true);
});

// suggestCorrectionDose is pure given a context, so build one by hand.
const ctx = (over = {}) => ({ stale: false, effectiveGlucose: 14, iob: 0, cob: 0, settings: { idealTarget: 6 }, ...over });
const factor = f => ({ factor: f, source: 'observed', sampleSize: 10 });
const suggest = (c, f = factor(2), boluses = [], corrections = []) =>
  E.suggestCorrectionDose(c, f, boluses, corrections, NOW);

test('correction = (glucose - target) / factor - IOB', () => {
  assert.equal(suggest(ctx()).suggestedUnits, 4);              // (14-6)/2
  assert.equal(suggest(ctx({ iob: 1 })).suggestedUnits, 3);    // minus active insulin
});

test('correction is never negative and never above the hard cap', () => {
  assert.equal(suggest(ctx({ effectiveGlucose: 5 })).suggestedUnits, 0);
  const big = suggest(ctx({ effectiveGlucose: 40 }), factor(1));
  assert.equal(big.suggestedUnits, E.MAX_SUGGESTED_UNITS);
  assert.equal(big.cappedAt10, true);
});

test('correction is withheld rather than guessed', () => {
  assert.equal(suggest(ctx({ stale: true })).withheldReason, 'stale-reading');
  assert.equal(suggest(ctx({ effectiveGlucose: null })).withheldReason, 'missing-data');
  assert.equal(suggest(ctx({ settings: {} })).withheldReason, 'missing-data');
  assert.equal(suggest(ctx(), factor(null)).withheldReason, 'insufficient-history');
  assert.equal(suggest(ctx(), factor(E.MIN_RELIABLE_FACTOR - 0.01)).withheldReason, 'low-confidence-factor');
  for (const r of [suggest(ctx({ stale: true })), suggest(ctx(), factor(null))]) {
    assert.equal(r.suggestedUnits, null);
  }
});

test('a recent dose still acting withholds a new correction (stacking)', () => {
  const r = suggest(ctx(), factor(2), [{ time: minsAgo(30), units: 4 }]);
  assert.equal(r.withheldReason, 'stacking-caution');
  assert.equal(r.suggestedUnits, null);
  // A dose past the stacking window doesn't block it.
  assert.equal(suggest(ctx(), factor(2), [{ time: minsAgo(300), units: 4 }]).withheldReason, null);
});

test('forecast result says which factor it used, plus IOB and trend', () => {
  const glucoseHistory = Array.from({ length: 12 }, (_, i) => ({ time: minsAgo(55 - i * 5), value: 12 + i * 0.1 }));
  const r = E.hyperForecast2h({ glucoseHistory, boluses: [], corrections: [],
    settings: { correctionFactor: 2.5, carbRatio: 10, targetHigh: 10, idealTarget: 6 } }, NOW);
  assert.equal(r.withheldReason, null);
  assert.equal(r.factorSource, 'pump-setting');
  assert.equal(r.iob, 0);
  assert.ok(r.trendPerMinute > 0);
  assert.equal(r.ctx, undefined);
});

// ── The learned model in the engine (Task 7) ───────────────────────────────
const BLOCKS = [[0, 3], [3, 6], [6, 9], [9, 12], [12, 15], [15, 18], [18, 21], [21, 24]];
const pad = h => String(h).padStart(2, '0');
const param = (value, pump, n = 18, extra = {}) =>
  ({ value, pump, n, source: 'learned', outsideBand: false, rateLimited: false, nPostExercise: 0, ...extra });
// isf / cr: { [fromHour]: param } overrides; default ISF 2.5 / CR 10 at pump 2.5 / 10.
function mkModel({ fittedAt = NOW, isf = {}, cr = {}, boost = 1, exercise = {}, modifiers = {}, meals = {}, forecastBias = [] } = {}) {
  return {
    version: 2, fittedAt,
    blocks: BLOCKS.map(([from, to]) => ({
      label: `${pad(from)}:00–${pad(to)}:00`, from, to,
      isf: isf[from] || param(2.5, 2.5), carbRatio: cr[from] || param(10, 10),
    })),
    allDay: { isf: 2.5, carbRatio: 10, nIsf: 40, nCr: 60 },
    exercise: { ...exercise, boost: { multiplier: boost, n: 6, nWithout: 20, hours: 24 } },
    modifiers: {
      siteAge: { active: false, effect: 1, n: 0 }, illness: { active: false, effect: 1, n: 0 },
      shortSleep: { active: false, effect: 1, n: 0 }, ...modifiers,
    },
    meals: { delayedRiseHighFat: { rate: null, n: 0 }, delayedRiseOther: { rate: null, n: 0 }, ...meals },
    forecastBias,
  };
}
const SETTINGS = { correctionFactor: 2.5, carbRatio: 10, targetLow: 4.5, targetHigh: 10, idealTarget: 6 };
const flat = (v, n = 12) => Array.from({ length: n }, (_, i) => ({ time: minsAgo(55 - i * 5), value: v }));

test('no model / stale model -> pump setting', () => {
  for (const model of [null, undefined, mkModel({ fittedAt: NOW - 49 * 3600000 })]) {
    const r = E.resolveCorrectionFactor([], { correctionFactor: 2.5 }, { model, atMs: NOW });
    assert.equal(r.factor, 2.5);
    assert.equal(r.source, 'pump-setting');
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
  }
  assert.equal(E.applyModel(null, NOW), null);
  assert.equal(E.applyModel(mkModel({ fittedAt: NOW - 49 * 3600000 }), NOW), null);
  // the old rolling average of past corrections no longer overrides the pump setting
  const resolved = Array.from({ length: 5 }, (_, i) => ({ time: minsAgo(600 + i * 60), resolved: true, carbInterference: false, dropPerUnit: 4 }));
  assert.equal(E.resolveCorrectionFactor(resolved, { correctionFactor: 2.5 }).source, 'pump-setting');
  const r = E.hyperForecast2h({ glucoseHistory: flat(14), boluses: [], corrections: [], settings: SETTINGS }, NOW);
  assert.ok(r.tier);
  assert.equal(r.factorSource, 'pump-setting');
});

test('fresh model uses the block for the hour', () => {
  const model = mkModel({ isf: { 6: param(3.0, 2.5), 18: param(2.0, 2.5) } });
  const at7 = Date.parse('2026-07-01T06:00:00Z');   // 07:00 London (BST)
  const at19 = Date.parse('2026-07-01T18:00:00Z');  // 19:00 London
  const m7 = { ...model, fittedAt: at7 - 3600000 }, m19 = { ...model, fittedAt: at19 - 3600000 };
  const r7 = E.resolveCorrectionFactor([], SETTINGS, { model: m7, atMs: at7 });
  const r19 = E.resolveCorrectionFactor([], SETTINGS, { model: m19, atMs: at19 });
  close(r7.factor, 3.0);
  close(r19.factor, 2.0);
  assert.equal(r7.source, 'learned');
  assert.equal(r7.sampleSize, 18);
  assert.ok(r7.reasons.includes('sensitivity 3.0 at this time of day (18 corrections)'), r7.reasons.join(' | '));
});

test('exercise only lowers doses', () => {
  const run = { workoutType: 'Run', startTime: minsAgo(180), endTime: minsAgo(120) };
  const input = (model, workouts) => ({ glucoseHistory: flat(7), boluses: [], corrections: [], settings: SETTINGS,
    activities: { workouts }, model });
  const base = E.suggestMealDose(input(mkModel({ boost: 1.2 }), []), 60, NOW);
  const after = E.suggestMealDose(input(mkModel({ boost: 1.2 }), [run]), 60, NOW);
  assert.ok(after.suggestedUnits <= base.suggestedUnits);
  close(after.suggestedUnits, 5);  // 60 / (10 * 1.2)
  assert.ok(after.reasons.includes("+20% after today's Run"), after.reasons.join(' | '));
  const bad = E.suggestMealDose(input(mkModel({ boost: 0.8 }), [run]), 60, NOW);
  close(bad.suggestedUnits, base.suggestedUnits);
  // capped at 1.3, then the result held inside the pump band
  const big = E.applyModel(mkModel({ boost: 2 }), NOW, { workouts: [run] });
  close(big.multiplier, 1.3);
  close(big.isf, 2.5 * 1.3);
  // a zero-length workout doesn't count
  const zero = E.applyModel(mkModel({ boost: 1.2 }), NOW, { workouts: [{ workoutType: 'Run', startTime: minsAgo(120), endTime: minsAgo(120) }] });
  close(zero.multiplier, 1);
});

test('forecast bias applied and capped', () => {
  const input = bias => ({ glucoseHistory: flat(8), boluses: [], corrections: [], settings: SETTINGS,
    model: mkModel({ forecastBias: [{ label: '12:00–15:00', from: 12, to: 15, bias, n: 30 }] }) });
  const a = E.hypoForecast2h(input(0), NOW);       // 12:00Z = 13:00 London
  const b = E.hypoForecast2h(input(-2.5), NOW);
  close(b.forecastGlucose - a.forecastGlucose, 1.0);
  const c = E.hypoForecast2h(input(0.4), NOW);
  close(c.forecastGlucose - a.forecastGlucose, -0.4);
  assert.ok(b.reasons.some(s => /forecast/.test(s)), b.reasons.join(' | '));
});

test('in-progress workout of a learned type lowers the forecast by its learned drop rate', () => {
  const input = workouts => ({ glucoseHistory: flat(9), boluses: [], corrections: [], settings: SETTINGS,
    activities: { workouts }, model: mkModel({ exercise: { Run: { dropPerMin: 0.05, n: 6 } } }) });
  const none = E.hypoForecast2h(input([]), NOW);
  const running = E.hypoForecast2h(input([{ workoutType: 'Run', startTime: minsAgo(30), endTime: new Date(NOW + 30 * 60000).toISOString() }]), NOW);
  close(none.forecastGlucose - running.forecastGlucose, 1.5);  // 0.05 x 30 remaining minutes
});

test('meal dose from model', () => {
  const r = E.suggestMealDose({ glucoseHistory: flat(7), boluses: [], corrections: [], settings: { ...SETTINGS, carbRatio: 12 },
    model: mkModel({ cr: { 12: param(10, 11, 25) } }) }, 60, NOW);
  assert.equal(r.suggestedUnits, 6);
  assert.equal(r.source, 'learned');
  assert.ok(r.reasons.includes('carb ratio 10.0 at this time of day (25 meals)'), r.reasons.join(' | '));
  const noModel = E.suggestMealDose({ glucoseHistory: flat(7), boluses: [], corrections: [], settings: SETTINGS }, 60, NOW);
  assert.equal(noModel.source, 'manual-carb-ratio');
  assert.equal(noModel.suggestedUnits, 6);
});

test('high forecast carries the learned block n for the alert wording', () => {
  const r = E.hyperForecast2h({ glucoseHistory: flat(14), boluses: [], corrections: [], settings: SETTINGS, model: mkModel() }, NOW);
  assert.equal(r.factorSource, 'learned');
  assert.equal(r.factorSampleSize, 18);
  assert.ok(Array.isArray(r.reasons) && r.reasons.length);
});

test('active modifier applies, inactive doesn\'t', () => {
  const on = mkModel({ modifiers: { siteAge: { active: true, effect: 0.85, n: 12 } } });
  const off = mkModel({ modifiers: { siteAge: { active: false, effect: 0.85, n: 12 } } });
  close(E.applyModel(on, NOW, { siteAgeHours: 60 }).isf, 2.5 * 0.85);
  close(E.applyModel(on, NOW, { siteAgeHours: 20 }).isf, 2.5);   // condition doesn't hold now
  close(E.applyModel(off, NOW, { siteAgeHours: 60 }).isf, 2.5);
  // a strong modifier is still held inside the pump band
  const strong = mkModel({ modifiers: { illness: { active: true, effect: 0.5, n: 12 } } });
  close(E.applyModel(strong, NOW, { rhrZ: 2 }).isf, 2.5 * 0.7);
});

test('held-back and outside-band blocks are named in the reasons', () => {
  const m = mkModel({ isf: { 12: param(1.75, 2.5, 30, { rateLimited: true, outsideBand: true }) } });
  const r = E.resolveCorrectionFactor([], SETTINGS, { model: m, atMs: NOW });
  assert.ok(r.reasons.includes('learned value held back while it settles'), r.reasons.join(' | '));
  assert.ok(r.reasons.includes('your data suggests outside ±30% of your pump setting — worth discussing'));
  assert.equal(r.outsideBand, true);
  assert.equal(r.rateLimited, true);
});

test('correction suggestion carries reasons', () => {
  const s = E.suggestCorrectionDose(ctx(), { factor: 2, source: 'learned', sampleSize: 18, reasons: ['sensitivity 2.0 at this time of day (18 corrections)'] }, [], [], NOW);
  assert.deepEqual(s.reasons, ['sensitivity 2.0 at this time of day (18 corrections)']);
});

test('learned late-rise suggests a split', () => {
  const model = mkModel({ meals: { delayedRiseHighFat: { rate: 0.7, n: 8 } } });
  const g = E.splitDoseGuide(30, 10, SETTINGS, { model, nowMs: NOW });
  assert.notEqual(g.tier, 'single');
  assert.ok(g.upfrontPct < 1);
  assert.ok(g.reasons.includes('your high-fat meals usually rise after 2½h (8 meals)'), (g.reasons || []).join(' | '));
  const plain = E.splitDoseGuide(30, 10, SETTINGS);
  assert.equal(plain.tier, g.tier);
  assert.deepEqual(plain.reasons, []);
  const few = E.splitDoseGuide(30, 10, SETTINGS, { model: mkModel({ meals: { delayedRiseHighFat: { rate: 0.7, n: 4 } } }), nowMs: NOW });
  assert.deepEqual(few.reasons, []);
  const m = E.suggestMacroMealDose({ glucoseHistory: flat(7), boluses: [], corrections: [], settings: SETTINGS, model },
    { carbs: 60, fat: 30, protein: 10 }, NOW);
  assert.ok(m.reasons.includes('your high-fat meals usually rise after 2½h (8 meals)'), m.reasons.join(' | '));
  assert.equal(m.source, 'learned');
});

test('sensitivityMap shows model blocks when a model is present', () => {
  const rows = E.sensitivityMap({ glucoseHistory: [], corrections: [], model: mkModel({ isf: { 6: param(3, 2.5, 9) } }) }, NOW);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[2], { timeOfDay: '06:00–09:00', isf: 3, carbRatio: 10, pumpIsf: 2.5, pumpCr: 10, n: 9, source: 'learned', outsideBand: false });
});

test('forecastAccuracyByBlock groups forecast errors by London block', () => {
  const glucoseHistory = Array.from({ length: 3 * 288 }, (_, i) => ({ time: new Date(NOW - i * 300000).toISOString(), value: 7 }));
  const rows = E.forecastAccuracyByBlock({ glucoseHistory, boluses: [], corrections: [], settings: SETTINGS }, NOW);
  assert.equal(rows.length, 8);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['bias', 'from', 'label', 'n', 'to']);
  assert.ok(rows.every(r => r.n > 0 && Math.abs(r.bias) < 1e-9));
});
