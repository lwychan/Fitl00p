const test = require('node:test');
const assert = require('node:assert');
const { simulatePatient } = require('./fixtures/sim-patient.js');

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
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  assert.deepStrictEqual(simulatePatient({ days: 60, seed: 1 }), p);
  assert.notDeepStrictEqual(simulatePatient({ days: 5, seed: 2 }).glucoseHistory, simulatePatient({ days: 5, seed: 3 }).glucoseHistory);
});
