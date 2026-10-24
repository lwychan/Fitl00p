// Body Battery engine — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/body-battery.js');

const H = 3600000;
const T0 = Date.UTC(2026, 9, 23, 22); // 23:00 UK, start of a night
const hr = (from, to, bpm, everyMin = 5) =>
  Array.from({ length: Math.floor((to - from) / (everyMin * 60000)) }, (_, i) => ({ t: from + i * everyMin * 60000, bpm }));
const base = { restingHr: 60, hrMax: 185, isFemale: false };

test('a good 7.5h night takes 25 to ~80; a short night charges much less', () => {
  const night = h => B.simulate({ ...base, start: T0, now: T0 + h * H, startLevel: 25,
    sleeps: [{ start: T0, end: T0 + h * H, asleepHrs: h, quality: 1 }] }).level;
  const full = night(7.5);
  assert.ok(full > 76 && full < 84, `full ${full}`);
  assert.ok(night(4) < full - 15);
});

test('sleep charges faster when the battery is low', () => {
  const gain = from => B.simulate({ ...base, start: T0, now: T0 + 6 * H, startLevel: from,
    sleeps: [{ start: T0, end: T0 + 6 * H, asleepHrs: 6, quality: 1 }] }).level - from;
  assert.ok(gain(20) > gain(70));
});

test('a hard hour of exercise drains roughly 25', () => {
  const r = B.simulate({ ...base, start: T0, now: T0 + H, startLevel: 80,
    workouts: [{ start: T0, end: T0 + H, name: 'Run', avgHr: 151 }], hrSamples: hr(T0, T0 + H, 151, 1) });
  const drop = 80 - r.level;
  assert.ok(drop > 20 && drop < 30, `drop ${drop}`);
  assert.equal(r.workouts.length, 1);
  assert.ok(Math.abs(r.workouts[0].delta + drop) < 1e-9);
});

test('calm rest recharges a little, raised heart rate drains', () => {
  const run = bpm => B.simulate({ ...base, start: T0, now: T0 + 2 * H, startLevel: 50, hrSamples: hr(T0, T0 + 2 * H, bpm) }).level;
  assert.ok(run(62) > 50 && run(62) < 55);
  assert.ok(run(100) < 50 - 5);
});

test('contributions add up exactly to the change since bedtime, and it never leaves 5-100', () => {
  const wake = T0 + 7 * H;
  const r = B.simulate({ ...base, start: T0 - 4 * H, now: wake + 10 * H, startLevel: 40, breakdownFrom: T0,
    sleeps: [{ start: T0, end: wake, asleepHrs: 6.5, quality: 1.1 }],
    workouts: [{ start: wake + 2 * H, end: wake + 3 * H, name: 'Strength', avgHr: 130 }],
    hrSamples: hr(wake, wake + 10 * H, 78) });
  const sum = Object.values(r.parts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(r.levelAtBreakdown + sum - r.level) < 1e-9);
  assert.ok(r.parts.sleep > 0 && r.parts.exercise < 0 && r.parts.stress < 0);
  r.series.forEach(p => assert.ok(p.level >= 5 && p.level <= 100));
  const low = B.simulate({ ...base, start: T0, now: T0 + 30 * H, startLevel: 10, hrSamples: hr(T0, T0 + 30 * H, 150) });
  assert.equal(low.level, 5);
});

test('sleepQuality and zones', () => {
  assert.equal(B.sleepQuality(0, 0), 1);
  assert.ok(B.sleepQuality(2, -1) > 1.2);
  assert.equal(B.sleepQuality(-10, 10), 0.5);
  assert.equal(B.zoneOf(80).key, 'high');
  assert.equal(B.zoneOf(51).key, 'medium');
  assert.equal(B.zoneOf(26).key, 'low');
  assert.equal(B.zoneOf(25).key, 'verylow');
});

test('groupSleepSessions joins a night, keeps a nap separate, counts only asleep time', () => {
  const m = 60000;
  const s = B.groupSleepSessions([
    { start: T0, end: T0 + 30 * m, asleep: false },          // in bed
    { start: T0 + 30 * m, end: T0 + 4 * H, asleep: true },
    { start: T0 + 4 * H + 20 * m, end: T0 + 7 * H, asleep: true }, // woke 20 min
    { start: T0 + 15 * H, end: T0 + 15.5 * H, asleep: true },      // afternoon nap
  ]);
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].asleepHrs - (3.5 + 8 / 3)) < 1e-9); // 3h30 + 2h40 asleep
  assert.equal(s[0].end, T0 + 7 * H);
  assert.equal(s[1].asleepHrs, 0.5);
});
