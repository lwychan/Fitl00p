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
