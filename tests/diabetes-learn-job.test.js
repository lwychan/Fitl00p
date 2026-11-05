// Task 8: adapter (Control-IQ auto-boluses, site changes), the pure parts of
// the nightly diabetes-learn job (episodesToScore, shouldLearn), and stacking
// caution ignoring automatic doses.
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/nightscout-adapter.js');
const E = require('../src/diabetes-engine.js');
const { simulatePatient } = require('./fixtures/sim-patient.js');

const H = 3600000;

/* ── Real tconnectsync treatment shapes (sampled from Lewis's Nightscout
   2026-10-24, identifiers dropped). Control-IQ automatic boluses arrive as
   eventType "Combo Bolus" with notes "Automatic Bolus" and carbs null. ── */
const autoBolus = { carbs: null, mills: 1792804589000, notes: 'Automatic Bolus', glucose: 197, insulin: 0.73,
  enteredBy: 'Pump (tconnectsync)', eventType: 'Combo Bolus', utcOffset: 60, created_at: '2026-10-24T01:16:29.000Z' };
const manualCorrection = { carbs: null, mills: 1792793244000, notes: 'BLE Standard Bolus (Override)', glucose: 166, insulin: 0.58,
  enteredBy: 'Pump (tconnectsync)', eventType: 'Combo Bolus', utcOffset: 60, created_at: '2026-10-23T22:07:24.000Z' };
const mealBolus = { carbs: 17, mills: 1792846254000, notes: 'BLE Standard Bolus', glucose: 160, insulin: 0.65,
  enteredBy: 'Pump (tconnectsync)', eventType: 'Combo Bolus', utcOffset: 60, created_at: '2026-10-24T12:50:54.000Z' };
// A Tandem site change logs two "Site Change" events a minute apart.
const cartridgeFill = { carbs: null, mills: 1792762324000, notes: 'Cartridge Filled (120u filled)', reason: 'Cartridge Filled (120u filled)',
  insulin: null, enteredBy: 'Pump (tconnectsync)', eventType: 'Site Change', utcOffset: 60, created_at: '2026-10-23T13:32:04.000Z' };
const cannulaFill = { carbs: null, mills: 1792762381000, notes: 'Cannula Filled (0.3u primed)', reason: 'Cannula Filled (0.3u primed)',
  insulin: null, enteredBy: 'Pump (tconnectsync)', eventType: 'Site Change', utcOffset: 60, created_at: '2026-10-23T13:33:01.000Z' };

test('adapter: Control-IQ automatic bolus → boluses { auto: true, carbs: 0 }, not a correction', () => {
  const out = A.adaptTreatments([autoBolus]);
  assert.strictEqual(out.corrections.length, 0);
  assert.strictEqual(out.boluses.length, 1);
  assert.strictEqual(out.boluses[0].auto, true);
  assert.strictEqual(out.boluses[0].carbs, 0);
  assert.strictEqual(out.boluses[0].units, 0.73);
});

test('adapter: manual no-carb bolus stays a correction; meal bolus is not auto', () => {
  const out = A.adaptTreatments([manualCorrection, mealBolus]);
  assert.strictEqual(out.corrections.length, 1);
  assert.strictEqual(out.corrections[0].units, 0.58);
  assert.strictEqual(out.boluses.length, 1);
  assert.ok(!out.boluses[0].auto);
});

test('adapter: one Tandem site change (cartridge + cannula fill) → siteChanges.length 1', () => {
  const out = A.adaptNightscoutData({ entries: [], treatments: [cartridgeFill, cannulaFill, autoBolus] });
  assert.strictEqual(out.siteChanges.length, 1);
  assert.strictEqual(out.siteChanges[0].time, Date.parse(cannulaFill.created_at));
});

test('adapter: site changes days apart both count; cartridge-only refill is not a site change', () => {
  const later = { ...cannulaFill, created_at: '2026-10-26T13:33:01.000Z', mills: undefined };
  const refillOnly = { ...cartridgeFill, created_at: '2026-10-28T09:00:00.000Z', mills: undefined };
  const out = A.adaptNightscoutData({ entries: [], treatments: [cartridgeFill, cannulaFill, later, refillOnly] });
  assert.strictEqual(out.siteChanges.length, 2);
});

/* Trio (iOS loop) shapes from the same Nightscout (stints 2026-09-14..17 and
   10-07..10): automatic doses are eventType "SMB"; manual doses "Bolus"; carbs
   arrive separately as "Carb Correction". Tandem extended-bolus portions come as
   "Combo Bolus" / notes "Extended Bolus" with no carbs. */
const trioSmb = { carbs: null, created_at: '2026-09-15T10:00:00.000Z', enteredBy: 'Trio', eventType: 'SMB', id: 'x', insulin: 0.15, utcOffset: 60 };
const trioBolus = { carbs: null, created_at: '2026-09-15T12:00:00.000Z', enteredBy: 'Trio', eventType: 'Bolus', id: 'y', insulin: 1.5, utcOffset: 60 };
const trioCarbs = { carbs: 30, created_at: '2026-09-15T12:01:00.000Z', enteredBy: 'Trio', eventType: 'Carb Correction', fat: 10, protein: 12, foodType: null, insulin: null, utcOffset: 60 };
const extended = { carbs: null, created_at: '2026-10-20T19:00:00.000Z', enteredBy: 'Pump (tconnectsync)', eventType: 'Combo Bolus', notes: 'Extended Bolus', insulin: 1.1, utcOffset: 60 };

test('adapter: Trio SMB → auto bolus; Trio manual Bolus → correction; Carb Correction → carbs', () => {
  const out = A.adaptTreatments([trioSmb, trioBolus, trioCarbs]);
  const auto = out.boluses.filter(b => b.auto);
  assert.strictEqual(auto.length, 1);
  assert.strictEqual(auto[0].units, 0.15);
  assert.strictEqual(out.corrections.length, 1);
  assert.strictEqual(out.corrections[0].units, 1.5);
  const meal = out.boluses.filter(b => b.carbs > 0);
  assert.strictEqual(meal.length, 1);
  assert.strictEqual(meal[0].carbs, 30);
});

test('adapter: Tandem extended-bolus portion is insulin, not a correction episode', () => {
  const out = A.adaptTreatments([extended]);
  assert.strictEqual(out.corrections.length, 0);
  assert.strictEqual(out.boluses.length, 1);
  assert.strictEqual(out.boluses[0].extended, true);
  assert.strictEqual(out.boluses[0].carbs, 0);
  assert.strictEqual(out.boluses[0].units, 1.1);
});

/* ── Stacking caution ignores Control-IQ automatic boluses ─────────── */
test('detectStackingCaution ignores auto: true doses (manual still flagged)', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const t = now - 40 * 60000;
  assert.deepStrictEqual(E.detectStackingCaution([{ time: t, units: 3, carbs: 0, auto: true }], [], now), []);
  assert.strictEqual(E.detectStackingCaution([{ time: t, units: 3, carbs: 0 }], [], now).length, 1);
});

test('auto boluses still count in IOB', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const iob = E.activeInsulin([{ time: now - 30 * 60000, units: 2, carbs: 0, auto: true }], [], now);
  assert.ok(iob > 1, `iob ${iob}`);
});

/* ── shouldLearn / episodesToScore ──────────────────────────────────── */
const sim = simulatePatient({ days: 21, seed: 3 });
const simIn = { glucoseHistory: sim.glucoseHistory, boluses: sim.boluses, corrections: sim.corrections,
  basalDoses: sim.basalDoses, activities: sim.activities };
const simEnd = sim.glucoseHistory[sim.glucoseHistory.length - 1].time;
const opts = { pumpProfile: sim.pumpProfile };

test('shouldLearn: false when < 144 readings in the last 24h, true on a full day', () => {
  assert.strictEqual(E.shouldLearn({ glucoseHistory: [] }, simEnd), false);
  assert.strictEqual(E.shouldLearn(null, simEnd), false);
  const thin = sim.glucoseHistory.filter((r, i) => i % 3 === 0);   // ~96/day
  assert.strictEqual(E.shouldLearn({ glucoseHistory: thin }, simEnd), false);
  assert.strictEqual(E.shouldLearn(simIn, simEnd), true);
  // a full day that ended > 24h ago doesn't count
  assert.strictEqual(E.shouldLearn(simIn, simEnd + 2 * 24 * H), false);
});

test('episodesToScore: empty glucoseHistory → []', () => {
  assert.deepStrictEqual(E.episodesToScore({ ...simIn, glucoseHistory: [] }, new Set(), simEnd, opts), []);
});

test('episodesToScore: every kind, finished only, keyed kind|startMs', () => {
  const eps = E.episodesToScore(simIn, new Set(), simEnd, opts);
  const kinds = new Set(eps.map(e => e.kind));
  for (const k of ['correction', 'meal', 'exercise', 'night']) assert.ok(kinds.has(k), `has ${k}`);
  for (const ep of eps) {
    assert.strictEqual(E.episodeKey(ep), `${ep.kind}|${ep.startMs}`);
    const endMs = ep.endMs ?? (ep.startMs + (ep.kind === 'meal' ? 300 : 240) * 60000);
    assert.ok(endMs <= simEnd, `${ep.kind} at ${ep.startMs} not finished`);
  }
  // keys unique
  assert.strictEqual(new Set(eps.map(E.episodeKey)).size, eps.length);
  // nothing from the final few hours (unfinished) — the last correction/meal is excluded
  const lastCorr = sim.corrections[sim.corrections.length - 1];
  if (lastCorr.time + 4 * H > simEnd) assert.ok(!eps.some(e => e.kind === 'correction' && e.startMs === lastCorr.time));
  // auto-boluses are not episodes
  assert.ok(!eps.some(e => sim.boluses.some(b => b.auto && b.time === e.startMs && e.kind === 'meal')));
});

test('episodesToScore: skips stored keys', () => {
  const all = E.episodesToScore(simIn, new Set(), simEnd, opts);
  const stored = new Set(all.filter((_, i) => i % 2 === 0).map(E.episodeKey));
  const rest = E.episodesToScore(simIn, stored, simEnd, opts);
  assert.strictEqual(rest.length, all.length - stored.size);
  assert.ok(rest.every(e => !stored.has(E.episodeKey(e))));
  assert.deepStrictEqual(E.episodesToScore(simIn, new Set(all.map(E.episodeKey)), simEnd, opts), []);
});

test('episodesToScore: an episode whose window has not elapsed is left for a later run', () => {
  const early = simEnd - 3 * 24 * H;
  const cut = { ...simIn, glucoseHistory: sim.glucoseHistory.filter(r => r.time <= early) };
  const eps = E.episodesToScore(cut, new Set(), early, opts);
  assert.ok(eps.length > 0);
  for (const ep of eps) assert.ok(ep.startMs < early);
  // a correction 1h before "now" is not finished
  const recent = sim.corrections.filter(c => c.time > early - 2 * H && c.time <= early);
  for (const c of recent) assert.ok(!eps.some(e => e.kind === 'correction' && e.startMs === c.time));
});

test('episodesToScore: maxEpisodes takes the oldest first so later runs continue', () => {
  const all = E.episodesToScore(simIn, new Set(), simEnd, opts);
  const first = E.episodesToScore(simIn, new Set(), simEnd, { ...opts, maxEpisodes: 10 });
  assert.strictEqual(first.length, 10);
  const sorted = [...all].sort((a, b) => a.startMs - b.startMs).slice(0, 10).map(E.episodeKey);
  assert.deepStrictEqual(first.map(E.episodeKey), sorted);
});

test('episodesToScore: meals are scored with the model ISF (isfAt) when a model is given', () => {
  const base = E.episodesToScore(simIn, new Set(), simEnd, opts);
  const model = E.fitModel(base, sim.pumpProfile, { nowMs: simEnd });
  // push every block's ISF 25% above pump (inside the band) so the meal fits must change
  model.blocks = model.blocks.map(b => ({ ...b, isf: { ...b.isf, value: b.isf.pump * 1.25 } }));
  const withModel = E.episodesToScore(simIn, new Set(), simEnd, { ...opts, model });
  const crOf = eps => new Map(eps.filter(e => e.kind === 'meal' && e.fit?.carbRatio != null).map(e => [e.startMs, e.fit.carbRatio]));
  const a = crOf(base), b = crOf(withModel);
  const shared = [...a.keys()].filter(k => b.has(k));
  assert.ok(shared.length > 5);
  assert.ok(shared.some(k => Math.abs(a.get(k) - b.get(k)) > 1e-6), 'model ISF changed meal fits');
});
