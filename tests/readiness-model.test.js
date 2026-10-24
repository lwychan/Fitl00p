// Recovery-score maths — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/readiness-model.js');

const days = (n, f, end = '2026-10-24') =>
  Array.from({ length: n }, (_, i) => ({ log_date: R.addDaysISO(end, -(n - i)), ...f(i) }));

test('personalBaseline: 30 days before the date only, needs 7 readings', () => {
  const hist = [...days(40, i => ({ resting_hr: i < 10 ? 90 : 60 + (i % 2) * 2 })), { log_date: '2026-10-24', resting_hr: 999 }];
  const b = R.personalBaseline(hist, 'resting_hr', '2026-10-24');
  assert.equal(b.n, 30);              // the 10 old 90s and today's 999 are excluded
  assert.equal(b.mean, 61);
  assert.ok(Math.abs(b.sd - 1.017) < 0.01);
  assert.equal(R.personalBaseline(days(6, () => ({ resting_hr: 60 })), 'resting_hr', '2026-10-24'), null);
});

test('scoreVsPersonalBaseline: 50 at normal, 20 points per SD, clamped', () => {
  const b = { mean: 60, sd: 3, log: false };
  assert.equal(R.scoreVsPersonalBaseline(60, b, false), 50);
  assert.equal(R.scoreVsPersonalBaseline(57, b, false), 70); // RHR 1 SD lower = better
  assert.equal(R.scoreVsPersonalBaseline(63, b, true), 70);
  assert.equal(R.scoreVsPersonalBaseline(80, b, false), 0);
  assert.equal(R.scoreVsPersonalBaseline(60.5, { mean: 60, sd: 0.1, log: false }, true, 1), 60); // SD floor
});

test('HRV is scored on a log scale, so a normal ±35% swing stays inside the range', () => {
  const hist = days(30, i => ({ hrv_ms: [30, 44, 60][i % 3] }));
  const b = R.personalBaseline(hist, 'hrv_ms', '2026-10-24', { log: true });
  const low = R.scoreVsPersonalBaseline(30, b, true, 0.05);
  const high = R.scoreVsPersonalBaseline(60, b, true, 0.05);
  assert.ok(low > 15 && low < 50, `low ${low}`);
  assert.ok(high > 50 && high < 85, `high ${high}`);
  assert.equal(R.scoreVsPersonalBaseline(0, b, true), null);
});

test('weightedSleepDebt: recent nights count most, capped at 1.5h', () => {
  assert.equal(R.weightedSleepDebt([1]), 0.35);
  assert.ok(Math.abs(R.weightedSleepDebt([0, 1]) - 0.28) < 1e-9);
  assert.equal(R.weightedSleepDebt([-2, 0]), 0);       // a long lie-in isn't negative debt
  assert.equal(R.weightedSleepDebt([3, 3, 3, 3, 3, 3, 3]), 1.5);
});

const DEFAULTS = { hrv: 0.4, rhr: 0.25, rr: 0.1, sleep: 0.25 };

test('fitRecoveryWeights: defaults until 14 check-ins', () => {
  const fit = R.fitRecoveryWeights([{ feel: 3, parts: { hrv: 50 } }], DEFAULTS);
  assert.equal(fit.active, false);
  assert.deepEqual(fit.weights, DEFAULTS);
});

test('fitRecoveryWeights: moves weight toward the factor that tracks how you feel', () => {
  // Feel follows sleep only; HRV is noise.
  const samples = Array.from({ length: 60 }, (_, i) => {
    const sleep = (i * 37) % 100, hrv = (i * 61) % 100;
    return { feel: 1 + Math.round(sleep / 25), parts: { hrv, rhr: 50, rr: 50, sleep } };
  });
  const fit = R.fitRecoveryWeights(samples, DEFAULTS);
  assert.equal(fit.active, true);
  assert.ok(fit.learned.sleep > 0.9, JSON.stringify(fit.learned));
  assert.ok(fit.weights.sleep > DEFAULTS.sleep && fit.weights.hrv < DEFAULTS.hrv);
  const sum = Object.values(fit.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(fit.blend - 60 / 90) < 1e-9);
});

test('fitRecoveryWeights: a factor going the wrong way gets 0, never negative', () => {
  const samples = Array.from({ length: 40 }, (_, i) => {
    const hrv = (i * 37) % 100;
    return { feel: 5 - Math.round(hrv / 25), parts: { hrv, rhr: (i * 13) % 100, rr: 50, sleep: 50 } };
  });
  const fit = R.fitRecoveryWeights(samples, DEFAULTS);
  if (fit.learned) assert.equal(fit.learned.hrv, 0);
  Object.values(fit.weights).forEach(w => assert.ok(w >= 0));
});

test('spearman', () => {
  assert.equal(R.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(R.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(R.spearman([1, 2], [1, 2]), null);
  assert.equal(R.spearman([1, 1, 1], [1, 2, 3]), null);
});
