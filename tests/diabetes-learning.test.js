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
