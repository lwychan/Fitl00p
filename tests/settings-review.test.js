'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SR = require('../src/settings-review.js');

const now = Date.UTC(2026, 10, 6);
const blk = (from, isf, cr) => ({ from, to: from + 3, label: `${String(from).padStart(2, '0')}:00–${String(from + 3).padStart(2, '0')}:00`, isf, carbRatio: cr });
const learned = (value, pump, n = 10, se = 0.3) => ({ value, pump, n, se, source: 'learned' });
const pooled = (value, pump) => ({ value, pump, n: 1, se: null, source: 'pooled' });
const pump = { default: [{ time: '00:00', basalRate: 0.8, correctionFactor: 5, carbRatio: 20 }] };
const night = (drift, day = 1) => ({ kind: 'night', startMs: now - day * 86400000, fit: { driftPerHr: drift, n: 60 }, confounded: null });

test('ignores pooled fallbacks and small differences', () => {
  const m = { blocks: [blk(6, pooled(9, 5), pooled(30, 20)), blk(9, learned(5.2, 5), learned(20.5, 20))] };
  assert.deepEqual(SR.blockItems(m), []);
});

test('suggests a capped, rounded ISF raise (less insulin) from learned evidence', () => {
  const [it] = SR.blockItems({ blocks: [blk(6, learned(6.5, 5, 7), pooled(20, 20))] });
  assert.equal(it.kind, 'isf'); assert.equal(it.direction, 'raise');
  assert.equal(it.changePct, 0.15); assert.equal(it.suggested, 5.8);
});

test('more-insulin moves need more evidence', () => {
  const lower = n => SR.blockItems({ blocks: [blk(6, learned(4.3, 5, n), pooled(20, 20))] });   // -14%
  assert.equal(lower(4).length, 0);
  assert.equal(lower(5).length, 1);
  assert.equal(SR.blockItems({ blocks: [blk(6, learned(4.7, 5, 20), pooled(20, 20))] }).length, 0); // -6% too small
});

test('needs a difference beyond 2 SE', () => {
  assert.equal(SR.blockItems({ blocks: [blk(6, learned(5.6, 5, 10, 0.4), pooled(20, 20))] }).length, 0);
});

test('carb ratio suggestion', () => {
  const [it] = SR.blockItems({ blocks: [blk(18, pooled(5, 5), learned(23, 20, 6, 1))] });
  assert.equal(it.kind, 'icr'); assert.equal(it.direction, 'raise'); assert.equal(it.suggested, 23);
});

test('overnight basal: consistent falling drift suggests a capped decrease', () => {
  const nights = Array.from({ length: 10 }, (_, i) => night(-1.0 - (i % 3) * 0.05, i + 1));
  const it = SR.basalItem(nights, pump, now);
  assert.equal(it.direction, 'lower'); assert.equal(it.changePct, -0.15); assert.equal(it.suggested, 0.68);
});

test('overnight basal: mixed drift, too few nights, confounded nights give nothing', () => {
  assert.equal(SR.basalItem(Array.from({ length: 10 }, (_, i) => night(i % 2 ? 0.6 : -0.6, i + 1)), pump, now), null);
  assert.equal(SR.basalItem(Array.from({ length: 7 }, (_, i) => night(-0.6, i + 1)), pump, now), null);
  assert.equal(SR.basalItem(Array.from({ length: 12 }, (_, i) => ({ ...night(-0.6, i + 1), confounded: 'implausible-fit' })), pump, now), null);
  assert.equal(SR.basalItem(Array.from({ length: 9 }, (_, i) => night(0.6, i + 1)), pump, now), null); // raise needs 10 nights
});

test('observations flag only strong, well-sampled forecast bias', () => {
  const m = { forecastBias: [{ from: 0, to: 3, label: '00:00–03:00', n: 17, bias: -1.75 }, { from: 3, to: 6, label: '03:00–06:00', n: 17, bias: 0.3 }, { from: 6, to: 9, label: '06:00–09:00', n: 5, bias: -3 }] };
  const o = SR.observations(m);
  assert.equal(o.length, 1); assert.equal(o[0].direction, 'higher');
});

test('real model 2026-11-06: no setting change, three observations', () => {
  const m = { blocks: [
    blk(0, learned(6.72, 7.22, 1, null), pooled(24.9, 20)), blk(3, learned(6.72, 7.22, 6, 1.5), pooled(24.9, 20)),
    blk(6, learned(4.51, 4.85, 11, 0.96), pooled(24.9, 23.3)), blk(9, pooled(3.9, 3.66), pooled(24.9, 25.3)),
    blk(12, pooled(3.9, 3.66), pooled(24.9, 26)), blk(15, learned(4.08, 3.66, 5, 0.79), pooled(24.9, 23.5)),
    blk(18, pooled(3.9, 3.66), learned(23.0, 23, 5, 2.1)), blk(21, learned(3.73, 3.66, 8, 1.09), pooled(24.9, 26))],
    forecastBias: [-1.75, 0.32, -0.71, -1.51, 0.02, -1.76, -1.06, -0.43].map((bias, i) => ({ from: i * 3, to: i * 3 + 3, label: `b${i}`, n: 18, bias })) };
  const r = SR.settingsReview({ model: m, nights: [], pumpProfile: pump, nowMs: now });
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.observations.map(o => o.from), [0, 9, 15]);
});

test('frequent unexplained-rise nights become an observation', () => {
  const n = (flag, i) => ({ ...night(0, i + 1), confounded: flag });
  const mk = k => [...Array.from({ length: k }, (_, i) => n('unexplained-rise', i)), ...Array.from({ length: 10 - k }, (_, i) => n(null, i + k))];
  assert.equal(SR.nightRiseObservation(mk(5), now), null);
  assert.equal(SR.nightRiseObservation(mk(6), now).kind, 'observation');
  assert.ok(SR.settingsReview({ model: {}, nights: mk(7), pumpProfile: pump, nowMs: now }).observations.some(o => o.id === 'night-rise'));
});

test('appliedDiffs lists every block where the dosing value differs from the pump by >= 3%', () => {
  const m = { blocks: [blk(0, learned(6.72, 7.22, 6), pooled(24.85, 20)), blk(3, pooled(4, 4.05), pooled(24, 26)), blk(6, learned(4.5, 4.85, 11), learned(23.03, 23, 5))] };
  const d = SR.appliedDiffs(m);
  assert.deepEqual(d.map(x => x.id), ['applied-isf-0', 'applied-icr-0', 'applied-icr-3', 'applied-isf-6']);
  const icr0 = d.find(x => x.id === 'applied-icr-0');
  assert.equal(icr0.pump, 20); assert.equal(icr0.app, 24.9); assert.equal(icr0.source, 'pooled'); assert.equal(icr0.effect, 'less insulin than pump');
});

// ---- outcome-driven review ----
const NOW = Date.UTC(2026, 10, 20, 12, 0);   // November: London == UTC
const HR = 3600000, M5 = 300000;
const dayStart = d => Date.UTC(2026, 10, 20 - d, 0, 0);
const flat = (from, to, v) => { const out = []; for (let t = from; t <= to; t += M5) out.push({ time: t, value: typeof v === 'function' ? v(t) : v }); return out; };
const targets = { low: 3.9, high: 10 };

test('basal outcome: Control-IQ delivers more than programmed and glucose still runs high -> raise', () => {
  const readings = [], basalDoses = [];
  for (let d = 1; d <= 10; d++) {
    readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, 11.5));
    for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: 1.0, durationMin: 60, units: 1.0 });
  }
  const items = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, pump, targets, NOW);
  const b0 = items.find(i => i.id === 'basal-0');
  assert.equal(b0.direction, 'raise'); assert.equal(b0.current, 0.8); assert.equal(b0.dataTarget, 1);
  assert.equal(b0.suggested, 0.925);   // capped at +15% (0.92) and rounded to 0.025
  assert.equal(b0.n, 10);
});

test('basal outcome: lows at the programmed rate -> lower; in range -> nothing', () => {
  const mk = v => { const readings = [], basalDoses = [];
    for (let d = 1; d <= 8; d++) { readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, v));
      for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: 0.8, durationMin: 60, units: 0.8 }); }
    return { glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }; };
  assert.equal(SR.basalOutcomeItems(mk(3.4), pump, targets, NOW)[0].direction, 'lower');
  assert.deepEqual(SR.basalOutcomeItems(mk(6.5), pump, targets, NOW), []);
});

test('basal outcome ignores windows with carbs in the previous 3 hours', () => {
  const readings = [], basalDoses = [], boluses = [];
  for (let d = 1; d <= 10; d++) { readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, 11.5));
    for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: 1.0, durationMin: 60, units: 1.0 });
    boluses.push({ time: dayStart(d) - HR, units: 3, carbs: 40 }); }   // 23:00 meal covers 00:00-03:00
  const items = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses, corrections: [] }, pump, targets, NOW);
  assert.ok(!items.some(i => i.id === 'basal-0'));
  assert.ok(items.some(i => i.id === 'basal-3'));
});

test('ICR outcome: lunches end high at the programmed ratio -> lower ratio (more insulin)', () => {
  const readings = [], boluses = [];
  for (let d = 1; d <= 8; d++) { const t = dayStart(d) + 12.5 * HR;
    readings.push(...flat(t - HR, t + 5 * HR, x => (x < t ? 6 : x < t + 4 * HR ? 6 + 6 * (x - t) / (4 * HR) : 12)));
    boluses.push({ time: t, units: 3, carbs: 60 }); }
  const [it] = SR.icrOutcomeItems({ glucoseHistory: readings, boluses, corrections: [] }, pump, targets, NOW);
  assert.equal(it.id, 'icr-12'); assert.equal(it.direction, 'lower'); assert.equal(it.current, 20);
  assert.equal(it.suggested, 17); assert.ok(it.dataTarget < 17);
});

test('ICR outcome: in-range meals, stacked meals and too few meals give nothing', () => {
  const mkMeals = (n, end, extra = []) => { const readings = [], boluses = [...extra];
    for (let d = 1; d <= n; d++) { const t = dayStart(d) + 12.5 * HR; readings.push(...flat(t - HR, t + 5 * HR, x => (x < t ? 6 : 6 + (end - 6) * Math.min(1, (x - t) / (4 * HR))))); boluses.push({ time: t, units: 3, carbs: 60 }); }
    return { glucoseHistory: readings, boluses, corrections: [] }; };
  assert.deepEqual(SR.icrOutcomeItems(mkMeals(8, 7), pump, targets, NOW), []);
  assert.deepEqual(SR.icrOutcomeItems(mkMeals(2, 13), pump, targets, NOW), []);
  const stacked = mkMeals(8, 13, Array.from({ length: 8 }, (_, i) => ({ time: dayStart(i + 1) + 13.5 * HR, units: 2, carbs: 30 })));
  assert.deepEqual(SR.icrOutcomeItems(stacked, pump, targets, NOW), []);
});

test('settingsReview uses outcome items for ICR/basal when glucose data is supplied', () => {
  const r = SR.settingsReview({ model: { blocks: [blk(6, learned(6.5, 5, 7), learned(30, 20, 9))] }, nights: [], pumpProfile: pump, input: { glucoseHistory: [], basalDoses: [], boluses: [], corrections: [] }, nowMs: NOW });
  assert.deepEqual(r.items.map(i => i.kind), ['isf']);   // model ICR is not used when outcome data is given
});

test('context: workout-affected windows are left out of basal figures and reported separately', () => {
  const readings = [], basalDoses = [], workouts = [];
  for (let d = 1; d <= 12; d++) {
    const lowDay = d <= 6;   // days 1-6 follow an evening workout and dip low overnight
    readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, lowDay ? 3.5 : 11.5));
    for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: lowDay ? 0.8 : 1.0, durationMin: 60, units: 1 });
    if (lowDay) workouts.push({ startMs: dayStart(d) - 3 * HR, endMs: dayStart(d) - 2 * HR });   // 21:00-22:00 the evening before
  }
  const notes = [];
  const items = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, pump, targets, NOW, { workouts }, notes);
  const b0 = items.find(i => i.id === 'basal-0');
  assert.equal(b0.direction, 'raise');                       // the dips after workouts are not read as "lower the basal"
  assert.equal(b0.n, 6);
  assert.match(b0.text, /workout-affected days were left out/);
  assert.ok(notes.some(n => n.id === 'ctx-ex-0'));           // ...but they are reported as an exercise effect
});

test('context: meals after short sleep that end higher are noted', () => {
  const readings = [], boluses = [], health = {};
  for (let d = 1; d <= 10; d++) {
    const t = dayStart(d) + 12.5 * HR, short = d <= 5, end = short ? 11 : 7.5;
    readings.push(...flat(t - HR, t + 5 * HR, x => (x < t ? 6 : 6 + (end - 6) * Math.min(1, (x - t) / (4 * HR)))));
    boluses.push({ time: t, units: 3, carbs: 60 });
    health[new Date(dayStart(d)).toISOString().slice(0, 10)] = { sleepHrs: short ? 5 : 7.5 };
  }
  const notes = [];
  SR.icrOutcomeItems({ glucoseHistory: readings, boluses, corrections: [] }, pump, targets, NOW, { workouts: [], health }, notes);
  assert.ok(notes.some(n => n.id === 'ctx-sleepmeal-12' && n.direction === 'higher'));
});

test('basal outcome: Control-IQ persistently cutting delivery while in range -> lower the programmed rate', () => {
  const readings = [], basalDoses = [];
  for (let d = 1; d <= 10; d++) { readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, 6));
    for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: 0.5, durationMin: 60, units: 0.5 }); }
  const b0 = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, pump, targets, NOW).find(i => i.id === 'basal-0');
  assert.equal(b0.direction, 'lower'); assert.equal(b0.dataTarget, 0.5); assert.equal(b0.suggested, 0.675);   // 0.8 -15% = 0.68 -> 0.675
});

test('basal outcome: Control-IQ adds ~25% and glucose is above range part of the time -> raise', () => {
  const readings = [], basalDoses = [];
  for (let d = 1; d <= 10; d++) { readings.push(...flat(dayStart(d), dayStart(d) + 24 * HR - M5, x => ((x - dayStart(d)) % (4 * HR) < 0.7 * HR ? 11 : 7)));   // ~17% above 10
    for (let h = 0; h < 24; h++) basalDoses.push({ time: dayStart(d) + h * HR, rate: 1.0, durationMin: 60, units: 1 }); }
  assert.equal(SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, pump, targets, NOW).find(i => i.id === 'basal-0').direction, 'raise');
});

test('Thursday data is left out when a separate Thursday profile exists', () => {
  const thuPump = { ...pump, thu: [{ time: '00:00', basalRate: 1.65, carbRatio: 15, correctionFactor: 2.3 }] };
  const readings = [], basalDoses = [];
  const days = []; for (let d = 1; d <= 14; d++) days.push(dayStart(d));
  for (const ds of days) { readings.push(...flat(ds, ds + 24 * HR - M5, 11.5)); for (let h = 0; h < 24; h++) basalDoses.push({ time: ds + h * HR, rate: 1.0, durationMin: 60, units: 1 }); }
  const withThu = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, thuPump, targets, NOW).find(i => i.id === 'basal-0');
  const without = SR.basalOutcomeItems({ glucoseHistory: readings, basalDoses, boluses: [], corrections: [] }, pump, targets, NOW).find(i => i.id === 'basal-0');
  assert.equal(without.n - withThu.n, 2);   // two Thursdays fall in the 14 completed days
});

test('thin basal coverage is reported', () => {
  const notes = [];
  SR.basalOutcomeItems({ glucoseHistory: flat(dayStart(1), dayStart(1) + 24 * HR, 6), basalDoses: [], boluses: [], corrections: [] }, pump, targets, NOW, null, notes);
  assert.ok(notes.some(n => n.id === 'basal-coverage'));
});
