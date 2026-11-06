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
  less: { n: 4, dev: 0.07 },
  more: { n: 5, dev: 0.08 },
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
const RISE = { minNights: 6, minShare: 0.4 };

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

// Nights where glucose rose by more than the logged insulin/carbs explain are excluded
// from the basal fit (they are confounded), but when they are common that IS the finding.
function nightRiseObservation(nights, nowMs) {
  const from = nowMs - BASAL.lookbackDays * DAY;
  const recent = (nights || []).filter(e => e && (e.startMs == null || e.startMs >= from));
  const rises = recent.filter(e => e.confounded === 'unexplained-rise');
  if (rises.length < RISE.minNights || rises.length / recent.length < RISE.minShare) return null;
  return {
    id: 'night-rise', kind: 'observation', window: '00:00–06:00', from: 0, to: 6, direction: 'higher', n: rises.length,
    text: `Overnight (00:00–06:00): on ${rises.length} of the last ${recent.length} nights glucose rose more than your logged insulin and food explain. Common causes are unlogged late food, a late meal's slow tail, a rebound after a low, or overnight basal / dawn rise. Worth checking those nights, and it is why a basal change cannot be suggested yet.`,
  };
}

// Every block where the value the app DOSES with (model.blocks[].value) differs from the pump
// profile by >= 3%: this is what makes a suggested dose deviate from the pump's for the same
// carbs / correction. 'pooled' = little data in that block, so the all-day average is used.
function appliedDiffs(model) {
  const out = [];
  for (const b of model?.blocks || []) {
    for (const [field, kind, name, unit, step] of [['isf', 'isf', 'Correction factor', 'mmol/L per U', 0.1], ['carbRatio', 'icr', 'Carb ratio', 'g per U', 0.1]]) {
      const x = b[field];
      if (!x || !(x.value > 0) || !(x.pump > 0)) continue;
      const dev = x.value / x.pump - 1;
      if (Math.abs(dev) < 0.03) continue;
      out.push({
        id: `applied-${kind}-${b.from}`, kind, window: b.label, from: b.from, to: b.to, name, unit,
        pump: round(x.pump, step), app: round(x.value, step), changePct: dev, source: x.source, n: x.n,
        // more insulin than the pump = a lower ratio value
        effect: dev > 0 ? 'less insulin than pump' : 'more insulin than pump',
      });
    }
  }
  return out;
}

/* ── Outcome-driven review (straight from glucose + pump data) ───────────────
   "At this programmed basal / carb ratio, did glucose run high or low?" Uses the last
   28 days of Nightscout data (CGM readings, boluses incl. Control-IQ auto-boluses, delivered
   basal segments), not the confounder-filtered episodes, because the ran-high cases are the
   ones the episode model throws away. Everything is a SUGGESTION: the data-implied value is
   shown, and the suggested next step is capped at 15% (repeat after a couple of weeks). */
const OUT = { days: 28, minWindows: 5, minMeals: 3, minGap: 0.08, minShare: 0.65, step: 0.15, lowShare: 0.08, highShare: 0.25,
  mealLow: 4.5, mealHigh: 8.0, hypo: 3.9 };
const HOUR = 3600000, MIN_MS = 60000;
const BLOCKS = [0, 3, 6, 9, 12, 15, 18, 21].map(f => ({ from: f, to: f + 3, label: `${String(f).padStart(2, '0')}:00–${String(f + 3).padStart(2, '0')}:00` }));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (v, d = 2) => String(Math.round(v * 10 ** d) / 10 ** d);

const _hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const _dk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });
function londonHour(ms) { const p = _hm.formatToParts(new Date(ms)); return Number(p.find(x => x.type === 'hour').value) + Number(p.find(x => x.type === 'minute').value) / 60; }
function londonDate(ms) { return _dk.format(new Date(ms)); }
const _wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' });
// a separate Thursday profile means Thursday data is not comparable with the weekday profile being reviewed
const otherProfileDay = (pumpProfile, ms) => !!(pumpProfile?.thu?.length) && _wd.format(new Date(ms)) === 'Thu';
function londonMidnight(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 0, 0);
  return t - Math.floor(londonHour(t)) * HOUR;   // BST: London hour at UTC midnight is 1
}
const nearest = (readings, t, tol = 10 * MIN_MS) => {
  let best = null, bd = Infinity;
  for (const r of readings) { const d = Math.abs(r.time - t); if (d < bd) { bd = d; best = r; } else if (r.time > t) break; }
  return best && bd <= tol ? best : null;
};
const between = (readings, a, b) => readings.filter(r => r.time >= a && r.time <= b);

// Health / workout context: ctx = { workouts: [{ startMs, endMs }], health: { 'YYYY-MM-DD': { sleepHrs } } }.
// Anything within EX_HOURS after a workout (or during one) is exercise-affected: workouts lower glucose
// and raise insulin sensitivity for hours, so those hours are reported separately, not mixed in.
const EX_HOURS = 10, SHORT_SLEEP = 6;
const exTouch = (ctx, a, b) => (ctx?.workouts || []).some(w => w.startMs <= b && w.endMs + EX_HOURS * HOUR >= a);
const shortSleep = (ctx, date) => { const h = ctx?.health?.[date]?.sleepHrs; return h != null && Number(h) > 0 && Number(h) < SHORT_SLEEP; };

function stepToward(current, target, cap) {
  const pct = clamp(target / current - 1, -cap, cap);
  return { pct, value: current * (1 + pct) };
}

function basalOutcomeItems(input, pumpProfile, targets, nowMs, ctx = null, notes = []) {
  const segs = pumpProfile?.default;
  const readings = (input?.glucoseHistory || []).filter(r => Number.isFinite(r.time) && Number.isFinite(r.value)).sort((a, b) => a.time - b.time);
  const basal = (input?.basalDoses || []).filter(b => Number.isFinite(b.time) && b.durationMin > 0 && Number.isFinite(b.rate));
  const carbTimes = (input?.boluses || []).filter(b => b.carbs > 0 && !b.auto).map(b => b.time);
  const corrTimes = (input?.corrections || []).filter(c => c.units > 0.3).map(c => c.time);
  if (!segs?.length || !readings.length) return [];
  const { low, high } = targets;
  const out = [], thin = [];
  const today = londonDate(nowMs);
  const days = []; for (let i = 1; i <= OUT.days; i++) days.push(londonDate(nowMs - i * 24 * HOUR));
  for (const b of BLOCKS) {
    const programmed = timeWeighted(segs, b.from, b.to, 'basalRate');
    if (!(programmed > 0)) continue;
    const wins = [], exWins = [];
    for (const day of days) {
      if (day === today || otherProfileDay(pumpProfile, londonMidnight(day) + 12 * HOUR)) continue;
      const wS = londonMidnight(day) + b.from * HOUR, wE = wS + (b.to - b.from) * HOUR;
      if (carbTimes.some(t => t >= wS - 3 * HOUR && t <= wE) || corrTimes.some(t => t >= wS - 2 * HOUR && t <= wE)) continue;   // fasting-like only
      const r = between(readings, wS, wE);
      if (r.length < (b.to - b.from) * 12 * 0.8) continue;
      let cover = 0, units = 0;
      for (const s of basal) {
        const a = Math.max(s.time, wS), z = Math.min(s.time + s.durationMin * MIN_MS, wE);
        if (z > a) { cover += z - a; units += s.rate * (z - a) / HOUR; }
      }
      if (cover < (wE - wS) * 0.7) continue;
      const q = Math.max(1, Math.round(r.length * 0.25));
      const w = { delivered: units / (cover / HOUR), mean: mean(r.map(x => x.value)), above: r.filter(x => x.value > high).length / r.length,
        below: r.filter(x => x.value < low).length / r.length, drift: mean(r.slice(-q).map(x => x.value)) - mean(r.slice(0, q).map(x => x.value)),
        short: shortSleep(ctx, day) };
      (exTouch(ctx, wS, wE) ? exWins : wins).push(w);
    }
    // context notes: lows after workouts; higher glucose on short-sleep days
    if (exWins.length >= 4) {
      const exBelow = mean(exWins.map(w => w.below)), baseBelow = wins.length ? mean(wins.map(w => w.below)) : 0;
      if (exBelow >= 0.15 && exBelow >= baseBelow + 0.08) notes.push({ id: `ctx-ex-${b.from}`, kind: 'observation', window: b.label, from: b.from, to: b.to, direction: 'lower', n: exWins.length,
        text: `${b.label}: within ${EX_HOURS}h of a workout your glucose was below ${fmt(low, 1)} for ${Math.round(exBelow * 100)}% of the time (${exWins.length} days) vs ${Math.round(baseBelow * 100)}% otherwise. That is exercise, not a basal-setting problem — a lower temporary basal or an exercise profile on training days fits better than changing the standing rate.` });
    }
    const sh = wins.filter(w => w.short), nm = wins.filter(w => !w.short);
    if (sh.length >= 4 && nm.length >= 4) {
      const d = mean(sh.map(w => w.above)) - mean(nm.map(w => w.above));
      if (Math.abs(d) >= 0.15) notes.push({ id: `ctx-sleep-${b.from}`, kind: 'observation', window: b.label, from: b.from, to: b.to, direction: d > 0 ? 'higher' : 'lower', n: sh.length,
        text: `${b.label}: after nights under ${SHORT_SLEEP}h sleep you spent ${Math.round(Math.abs(d) * 100)} points ${d > 0 ? 'more' : 'less'} of the time above ${fmt(high, 1)} (${sh.length} short-sleep vs ${nm.length} normal days). ${d > 0 ? 'Poor sleep raises insulin resistance, so some of this is sleep rather than the settings.' : ''}` });
    }
    if (wins.length < OUT.minWindows) { thin.push(b.label); continue; }
    const delivered = mean(wins.map(w => w.delivered)), gap = delivered / programmed - 1;
    const above = mean(wins.map(w => w.above)), below = mean(wins.map(w => w.below)), g = mean(wins.map(w => w.mean));
    const upShare = wins.filter(w => w.drift > 0.5).length / wins.length;
    let direction = null, target = null, why = '';
    const cut = Math.round(-gap * 100), add = Math.round(gap * 100);
    if (below >= OUT.lowShare) { direction = 'lower'; target = programmed * (1 - Math.min(0.15, 0.05 + below)); why = `glucose was below ${fmt(low, 1)} for ${Math.round(below * 100)}% of these hours`; }
    else if (gap <= -0.15 && above < OUT.highShare) { direction = 'lower'; target = delivered; why = `Control-IQ held delivery at ${fmt(delivered)} U/h on average, ${cut}% below the programmed ${fmt(programmed)}, and you stayed in range (${fmt(g, 1)} mmol/L average) — the programmed rate looks higher than you need here`; }
    else if (gap <= -OUT.minGap && below >= 0.03) { direction = 'lower'; target = delivered; why = `Control-IQ delivered only ${fmt(delivered)} U/h (${cut}% below the programmed ${fmt(programmed)}) and glucose dipped under ${fmt(low, 1)} ${Math.round(below * 100)}% of the time`; }
    else if (gap >= OUT.minGap && (above >= 0.10 || g > high - 1.5)) { direction = 'raise'; target = delivered; why = `Control-IQ had to add ${add}% on top of the programmed ${fmt(programmed)} (${fmt(delivered)} U/h delivered) and glucose still averaged ${fmt(g, 1)}, above ${fmt(high, 1)} ${Math.round(above * 100)}% of the time`; }
    else if (upShare >= OUT.minShare && above >= OUT.highShare) { direction = 'raise'; target = programmed * 1.1; why = `glucose rose over ${Math.round(upShare * 100)}% of these hours despite basal at ${fmt(delivered)} U/h, and was above ${fmt(high, 1)} ${Math.round(above * 100)}% of the time`; }
    if (!direction) continue;
    const st = stepToward(programmed, target, OUT.step);
    const suggested = round(st.value, 0.025);
    if (Math.abs(suggested - programmed) < 0.0125) continue;
    out.push({ id: `basal-${b.from}`, kind: 'basal', window: b.label, from: b.from, to: b.to, direction, current: round(programmed, 0.005), suggested,
      dataTarget: round(target, 0.005), unit: 'U/h', changePct: st.pct, n: wins.length, confidence: wins.length >= 10 ? 'good' : 'moderate',
      text: `${b.label} basal: over ${wins.length} fasting-like days ${why}. Consider ${direction === 'raise' ? 'raising' : 'lowering'} it from ${fmt(programmed)} to ${fmt(suggested)} U/h (${pct(st.pct)})${Math.abs(st.pct) >= OUT.step - 1e-9 ? '; the data points further, to about ' + fmt(target) + ' — reassess after a couple of weeks' : ''}, and discuss with your team.${exWins.length ? ` (${exWins.length} workout-affected days were left out.)` : ''}` });
  }
  if (thin.length) notes.push({ id: 'basal-coverage', kind: 'observation', window: thin.join(', '), from: 0, to: 24, direction: 'info', n: thin.length,
    text: `Basal can't be judged for ${thin.join(', ')}: fewer than ${OUT.minWindows} days had a stretch with no meal or correction bolus in the previous 3 hours, so meals dominate those hours. Meal boluses (carb ratio) are what is reviewed there.` });
  return out;
}

function icrOutcomeItems(input, pumpProfile, targets, nowMs, ctx = null, notes = []) {
  const segs = pumpProfile?.default;
  const readings = (input?.glucoseHistory || []).filter(r => Number.isFinite(r.time) && Number.isFinite(r.value)).sort((a, b) => a.time - b.time);
  const all = input?.boluses || [];
  const meals = all.filter(b => b.carbs >= 20 && !b.auto && b.time >= nowMs - OUT.days * 24 * HOUR && b.time <= nowMs - 5 * HOUR).sort((a, b) => a.time - b.time);
  const corr = (input?.corrections || []).filter(c => c.units > 0.3).map(c => c.time);
  if (!segs?.length || !readings.length) return [];
  const per = BLOCKS.map(() => []), exMeals = BLOCKS.map(() => []), shortMeals = BLOCKS.map(() => []);
  for (const m of meals) {
    const t = m.time;
    if (otherProfileDay(pumpProfile, t)) continue;
    if (all.some(o => o !== m && o.carbs > 0 && !o.auto && o.time > t - 3 * HOUR && o.time < t + 4 * HOUR)) continue;   // stacked meals
    if (corr.some(c => c > t - HOUR && c < t + 4 * HOUR)) continue;                                                    // correction muddles the outcome
    const g0 = nearest(readings, t), gEnd = nearest(readings, t + 4 * HOUR);
    if (!g0 || !gEnd) continue;
    const r = between(readings, t, t + 4 * HOUR);
    if (r.length < 36) continue;
    const lowest = Math.min(...r.map(x => x.value));
    const h = londonHour(t), blockIdx = Math.min(7, Math.floor(h / 3));
    const isf = timeWeighted(segs, h, Math.min(24, h + 0.01), 'correctionFactor') ?? timeWeighted(segs, blockIdx * 3, blockIdx * 3 + 3, 'correctionFactor');
    if (!(isf > 0)) continue;
    let dev = gEnd.value > OUT.mealHigh ? gEnd.value - OUT.mealHigh : gEnd.value < OUT.mealLow ? gEnd.value - OUT.mealLow : 0;
    if (lowest < OUT.hypo && dev >= 0) dev = lowest - OUT.mealLow;
    const ideal = Math.max(0.2, m.units + dev / isf);
    const rec = { icr: clamp(m.carbs / ideal, 3, 60), dev, units: m.units, carbs: m.carbs, short: shortSleep(ctx, londonDate(t)) };
    if (exTouch(ctx, t, t + 4 * HOUR)) exMeals[blockIdx].push(rec); else { per[blockIdx].push(rec); if (rec.short) shortMeals[blockIdx].push(rec); }
  }
  BLOCKS.forEach((b, i) => {
    if (exMeals[i].length >= 3) {
      const d = mean(exMeals[i].map(x => x.dev)), base = per[i].length ? mean(per[i].map(x => x.dev)) : 0;
      if (d <= -0.5 && d <= base - 0.7) notes.push({ id: `ctx-exmeal-${b.from}`, kind: 'observation', window: b.label, from: b.from, to: b.to, direction: 'lower', n: exMeals[i].length,
        text: `${b.label} meals eaten within ${EX_HOURS}h of a workout ended about ${fmt(Math.abs(d), 1)} mmol/L lower than your normal meals (${exMeals[i].length} meals) — training lowers how much insulin a meal needs, so those meals were left out of the carb-ratio figures. Consider a smaller bolus after training rather than a standing ratio change.` });
    }
    const sh = shortMeals[i], nm = per[i].filter(x => !x.short);
    if (sh.length >= 3 && nm.length >= 3) {
      const d = mean(sh.map(x => x.dev)) - mean(nm.map(x => x.dev));
      if (d >= 1) notes.push({ id: `ctx-sleepmeal-${b.from}`, kind: 'observation', window: b.label, from: b.from, to: b.to, direction: 'higher', n: sh.length,
        text: `${b.label} meals after a night under ${SHORT_SLEEP}h sleep ended about ${fmt(d, 1)} mmol/L higher than after normal nights (${sh.length} vs ${nm.length} meals) — poor sleep makes insulin less effective, so part of any high is sleep, not the carb ratio.` });
    }
  });
  const out = [];
  BLOCKS.forEach((b, i) => {
    const xs = per[i];
    if (xs.length < OUT.minMeals) return;
    const current = timeWeighted(segs, b.from, b.to, 'carbRatio');
    if (!(current > 0)) return;
    const target = median(xs.map(x => x.icr));
    const dev = target / current - 1;
    const sameSide = xs.filter(x => (dev > 0 ? x.icr > current : x.icr < current)).length / xs.length;
    if (Math.abs(dev) < 0.06 || sameSide < OUT.minShare) return;
    const high = xs.filter(x => x.dev > 0).length, low = xs.filter(x => x.dev < 0).length, inRange = xs.length - high - low;
    const actual = median(xs.map(x => x.carbs / x.units));
    const direction = dev > 0 ? 'raise' : 'lower';
    const st = stepToward(current, target, OUT.step);
    const suggested = round(st.value, 0.5);
    if (suggested === round(current, 0.5)) return;
    out.push({ id: `icr-${b.from}`, kind: 'icr', window: b.label, from: b.from, to: b.to, direction, current: round(current, 0.5), suggested, dataTarget: round(target, 0.5),
      unit: 'g per U', changePct: st.pct, n: xs.length, confidence: xs.length >= 8 ? 'good' : 'moderate',
      text: `${b.label} meals: pump ${fmt(current, 1)} g/U, but across ${xs.length} meals you actually dosed about ${fmt(actual, 1)} g/U. 4 hours later ${inRange} ended in range, ${high} above ${OUT.mealHigh} and ${low} below ${OUT.mealLow} (or dipped under ${OUT.hypo}). The ratio that would have kept them in range averages about ${fmt(target, 1)} g/U. Consider ${direction === 'raise' ? 'raising' : 'lowering'} it to ${fmt(suggested, 1)} (${pct(st.pct)})${Math.abs(st.pct) >= OUT.step - 1e-9 ? '; the data points further, reassess after a couple of weeks' : ''}, and discuss with your team.${exMeals[i].length ? ` (${exMeals[i].length} meals within ${EX_HOURS}h of a workout were left out.)` : ''}` });
  });
  return out;
}

function settingsReview({ model, nights, pumpProfile, input = null, targets = null, context = null, nowMs = Date.now() } = {}) {
  const ctxNotes = [];
  const tg = { low: Number(targets?.low) || 3.9, high: Number(targets?.high) || 10 };
  // ISF from the learned model (corrections); carb ratio and basal from outcomes when glucose/pump data is supplied
  const items = blockItems(model).filter(i => (input ? i.kind === 'isf' : true));
  if (input) items.push(...icrOutcomeItems(input, pumpProfile, tg, nowMs, context, ctxNotes), ...basalOutcomeItems(input, pumpProfile, tg, nowMs, context, ctxNotes));
  else { const basal = basalItem(nights, pumpProfile, nowMs); if (basal) items.push(basal); }
  items.sort((a, b) => a.from - b.from);
  const notes = observations(model);
  const rise = nightRiseObservation(nights, nowMs);
  if (rise) notes.push(rise);
  notes.push(...ctxNotes);
  return { generatedAt: nowMs, items, observations: notes, applied: appliedDiffs(model), nothing: !items.length && !notes.length };
}

const SettingsReview = { settingsReview, blockItems, basalItem, observations, nightRiseObservation, appliedDiffs, basalOutcomeItems, icrOutcomeItems, MAX_CHANGE };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SettingsReview;
} else if (typeof window !== 'undefined') {
  window.SettingsReview = SettingsReview;
}

})();
