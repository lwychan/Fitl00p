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
  assert.equal(lower(7).length, 0);
  assert.equal(lower(8).length, 1);
  assert.equal(SR.blockItems({ blocks: [blk(6, learned(4.55, 5, 20), pooled(20, 20))] }).length, 0); // -9% too small
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
