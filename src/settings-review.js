'use strict';

// Pump-settings review: turns the nightly learned model (dx_model) and the
// stored overnight episodes into suggestions to REVIEW correction factor (ISF),
// carb ratio (ICR) and overnight basal by time of day, plus plain observations
// ("runs higher than forecast 15:00-18:00") where there is a pattern but no
// safe number. fitl00p never changes the pump: every item is "consider ...,
// discuss with your team".
//
// Safety rules (same philosophy as the learning design):
//  - a change is only suggested from LEARNED evidence (not pooled fallbacks),
//    with a minimum sample, a minimum size, and a difference larger than 2 SE;
//  - never more than +/-15% from what the pump has now;
//  - asymmetric: moves that make the pump deliver MORE insulin (lower ISF /
//    lower ICR / higher basal) need more evidence than moves that deliver less;
//  - suggestions only, nothing is applied.
// Pure functions, unit-tested in tests/settings-review.test.js.
(function () {

const MAX_CHANGE = 0.15;
const R = {
  // minimum samples / relative difference for fewer-insulin / more-insulin moves
  less: { n: 6, dev: 0.10 },
  more: { n: 8, dev: 0.12 },
};
const BASAL = {
  lookbackDays: 28,
  minNights: 8,
  minNightsRaise: 10,
  minDrift: 0.25,       // mmol/L/h unexplained overnight drift
  minDriftRaise: 0.30,
  minConsistency: 0.75, // share of nights drifting the same way
};
const OBS = { minN: 15, minBias: 1.5 };

const DAY = 86400000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, step) => Number((Math.round(v / step) * step).toFixed(4));
const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

function timeWeighted(segments, from, to, field) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const hh = t => { const [h, m] = String(t).split(':').map(Number); return h + (m || 0) / 60; };
  const s = [...segments].sort((a, b) => hh(a.time) - hh(b.time));
  let w = 0, sum = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.max(from, hh(s[i].time)), b = Math.min(to, i + 1 < s.length ? hh(s[i + 1].time) : 24);
    if (b > a && s[i][field] != null) { w += b - a; sum += Number(s[i][field]) * (b - a); }
  }
  return w > 0 ? sum / w : null;
}

function blockItems(model) {
  const out = [];
  for (const b of model?.blocks || []) {
    for (const [field, kind, name, unit, step] of [['isf', 'isf', 'Correction factor', 'mmol/L per U', 0.1], ['carbRatio', 'icr', 'Carb ratio', 'g per U', 0.5]]) {
      const x = b[field];
      if (!x || x.source !== 'learned' || x.pump == null || !(x.value > 0) || !(x.pump > 0)) continue;
      const dev = x.value / x.pump - 1;
      const direction = dev > 0 ? 'raise' : 'lower';
      const need = direction === 'raise' ? R.less : R.more;   // raising ISF/ICR = less insulin
      if (x.n < need.n || Math.abs(dev) < need.dev) continue;
      if (x.se != null && Math.abs(x.value - x.pump) <= 2 * x.se) continue;
      const changePct = clamp(dev, -MAX_CHANGE, MAX_CHANGE);
      const suggested = round(x.pump * (1 + changePct), step);
      if (suggested === round(x.pump, step)) continue;
      out.push({
        id: `${kind}-${b.from}`, kind, window: b.label, from: b.from, to: b.to, direction,
        current: round(x.pump, step), evidence: round(x.value, step), suggested, unit, changePct, n: x.n,
        confidence: x.n >= 12 ? 'good' : 'moderate',
        text: `${b.label} ${name.toLowerCase()}: pump ${f1(x.pump)}, your data says about ${f1(x.value)} ${unit} (${x.n} ${kind === 'isf' ? 'corrections' : 'meals'}). Consider ${direction === 'raise' ? 'raising' : 'lowering'} it to ${f1(suggested)} (${pct(changePct)}) and discuss with your team.`,
      });
    }
  }
  return out;
}

// Overnight basal from stored night episodes (fit.driftPerHr = glucose change per
// hour the logged insulin, carbs and Control-IQ activity do not explain).
function basalItem(nights, pumpProfile, nowMs) {
  const from = nowMs - BASAL.lookbackDays * DAY;
  const clean = (nights || []).filter(e => e && !e.confounded && e.fit && Number.isFinite(e.fit.driftPerHr) && (e.startMs == null || e.startMs >= from));
  if (clean.length < BASAL.minNights) return null;
  const drifts = clean.map(e => e.fit.driftPerHr);
  const med = median(drifts);
  const raise = med > 0;
  const share = drifts.filter(d => Math.sign(d) === (raise ? 1 : -1)).length / drifts.length;
  if (share < BASAL.minConsistency) return null;
  if (Math.abs(med) < (raise ? BASAL.minDriftRaise : BASAL.minDrift)) return null;
  if (raise && clean.length < BASAL.minNightsRaise) return null;
  const segs = pumpProfile?.default;
  const basal = timeWeighted(segs, 0, 6, 'basalRate');
  const isf = timeWeighted(segs, 0, 6, 'correctionFactor');
  if (!(basal > 0) || !(isf > 0)) return null;
  const needUnitsPerHr = med / isf;                 // positive = needs more basal
  const changePct = clamp(needUnitsPerHr / basal, -MAX_CHANGE, MAX_CHANGE);
  const suggested = round(basal * (1 + changePct), 0.005);
  if (Math.abs(suggested - basal) < 0.005) return null;
  const r3 = v => Math.round(v * 1000) / 1000;
  return {
    id: 'basal-0', kind: 'basal', window: '00:00–06:00', from: 0, to: 6, direction: raise ? 'raise' : 'lower',
    current: r3(basal), suggested: r3(suggested), unit: 'U/h', changePct, n: clean.length,
    confidence: clean.length >= 14 ? 'good' : 'moderate',
    text: `Overnight basal (00:00–06:00): across ${clean.length} clean nights your glucose ${raise ? 'rises' : 'falls'} about ${f1(Math.abs(med))} mmol/L per hour more than your insulin explains (${Math.round(share * 100)}% of nights). Pump average ${r3(basal)} U/h; consider ${raise ? 'raising' : 'lowering'} it to about ${r3(suggested)} (${pct(changePct)}) and discuss with your team.`,
  };
}

// bias = predicted - actual, so a negative bias means glucose came out HIGHER
// than the model expected in that block.
function observations(model) {
  const out = [];
  for (const b of model?.forecastBias || []) {
    if (!b || b.n < OBS.minN || !Number.isFinite(b.bias) || Math.abs(b.bias) < OBS.minBias) continue;
    const higher = b.bias < 0;
    out.push({
      id: `bias-${b.from}`, kind: 'observation', window: b.label, from: b.from, to: b.to,
      direction: higher ? 'higher' : 'lower', bias: Math.round(Math.abs(b.bias) * 10) / 10, n: b.n,
      text: `${b.label}: glucose usually ends up about ${f1(Math.abs(b.bias))} mmol/L ${higher ? 'higher' : 'lower'} than the forecast expects (${b.n} checks) — look at ${higher ? 'basal, meal doses or unlogged food' : 'basal, correction doses or activity'} around then.`,
    });
  }
  return out;
}

function settingsReview({ model, nights, pumpProfile, nowMs = Date.now() } = {}) {
  const items = blockItems(model);
  const basal = basalItem(nights, pumpProfile, nowMs);
  if (basal) items.push(basal);
  items.sort((a, b) => a.from - b.from);
  const notes = observations(model);
  return { generatedAt: nowMs, items, observations: notes, nothing: !items.length && !notes.length };
}

const SettingsReview = { settingsReview, blockItems, basalItem, observations, MAX_CHANGE };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SettingsReview;
} else if (typeof window !== 'undefined') {
  window.SettingsReview = SettingsReview;
}

})();
