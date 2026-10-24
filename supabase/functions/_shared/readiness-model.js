// GENERATED from src/readiness-model.js by scripts/sync-shared.mjs — edit that file, not this one.
'use strict';

// Pure maths behind the Recovery score — kept out of app.js so it can be
// unit-tested (tests/readiness-model.test.js).
//
// 1. Personal baselines: each input is scored by how many of YOUR OWN
//    standard deviations today sits from your 30-day mean (a z-score), not
//    by a fixed % — HRV naturally swings ~35% day to day, resting HR ~5%,
//    so one fixed % scale either saturates on normal noise or never moves.
//    HRV is log-transformed first (it's right-skewed; ln-HRV is the
//    standard in the HRV-guided-training literature, e.g. Plews 2012).
// 2. Learning from the morning check-in: once there are enough "how do you
//    feel" answers, fitRecoveryWeights() finds which inputs actually track
//    how this person feels and shifts the weights toward them, shrunk
//    toward the defaults until there's plenty of data.
const ReadinessModelNS = (function () {

const DAY_MS = 86400000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const addDaysISO = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

// Mean/SD of `field` over the `days` before `beforeDate` (exclusive).
// null below `minN` readings — callers fall back to cruder scoring.
function personalBaseline(history, field, beforeDate, { log = false, days = 30, minN = 7 } = {}) {
  const from = addDaysISO(beforeDate, -days);
  const vals = (history || [])
    .filter(h => h.log_date < beforeDate && h.log_date >= from && h[field] != null)
    .map(h => Number(h[field]))
    .filter(v => Number.isFinite(v) && (!log || v > 0))
    .map(v => (log ? Math.log(v) : v));
  if (vals.length < minN) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
  return { mean, sd, n: vals.length, log };
}

// 50 = your normal; each SD better/worse moves 20 points (±2.5 SD = 100/0).
// sdFloor stops a very steady stretch turning tiny wobbles into big swings.
function scoreVsPersonalBaseline(value, stats, higherIsBetter, sdFloor) {
  if (value == null || !stats || (stats.log && !(value > 0))) return null;
  const x = stats.log ? Math.log(value) : Number(value);
  const z = (x - stats.mean) / Math.max(stats.sd, sdFloor || 0);
  return clamp(50 + (higherIsBetter ? z : -z) * 20, 0, 100);
}

// Sleep debt from the shortfalls (hours under need) of recent nights,
// newest first. Older nights count less (decay per night) — lab
// sleep-restriction studies (Van Dongen 2003; Kitamura 2016) show debt
// builds over a week and takes several nights to clear, so a 3-night
// window forgot it too fast. Capped: one night can't repay a week.
function weightedSleepDebt(shortfallsNewestFirst, { perNight = 0.35, decay = 0.8, cap = 1.5 } = {}) {
  const debt = (shortfallsNewestFirst || []).reduce((sum, s, i) => sum + Math.max(0, s) * perNight * decay ** i, 0);
  return Math.min(cap, debt);
}

// Solve A x = b (small, dense) by Gaussian elimination with pivoting.
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Non-negative ridge regression of feel on the factor sub-scores. Exact for
// a handful of factors: try every subset, keep the best all-positive fit.
// (A factor that goes the "wrong" way — higher HRV score, feeling worse —
// gets weight 0, not a negative weight.)
function nonNegativeRidge(X, y, ridge) {
  const n = y.length, k = X[0].length;
  const xMean = Array.from({ length: k }, (_, j) => X.reduce((a, r) => a + r[j], 0) / n);
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const Xc = X.map(r => r.map((v, j) => v - xMean[j]));
  const yc = y.map(v => v - yMean);
  const lambda = ridge * n;
  let best = { beta: new Array(k).fill(0), loss: yc.reduce((a, v) => a + v * v, 0) };
  for (let mask = 1; mask < 1 << k; mask++) {
    const cols = [...Array(k).keys()].filter(j => mask & (1 << j));
    const A = cols.map(a => cols.map(b => Xc.reduce((s, r) => s + r[a] * r[b], 0) + (a === b ? lambda : 0)));
    const rhs = cols.map(a => Xc.reduce((s, r, i) => s + r[a] * yc[i], 0));
    const sol = solve(A, rhs);
    if (!sol || sol.some(v => v < 0)) continue;
    const beta = new Array(k).fill(0);
    cols.forEach((c, i) => { beta[c] = sol[i]; });
    const loss = Xc.reduce((s, r, i) => s + (yc[i] - r.reduce((a, v, j) => a + v * beta[j], 0)) ** 2, 0)
      + lambda * beta.reduce((a, v) => a + v * v, 0);
    if (loss < best.loss) best = { beta, loss };
  }
  return best.beta;
}

// samples: [{ feel: 1-5, parts: { hrv, rhr, rr, sleep } }] — parts are the
// 0-100 sub-scores computeRecoveryScore produced that morning (missing =
// 50, i.e. "normal", so a night without a reading neither helps nor hurts).
// Returns weights over the same keys as `defaults`, summing to the same
// total. Below minSamples, or with no usable signal, the defaults come back
// unchanged; above it the learned weights are blended in with weight
// n / (n + prior), so 30 check-ins = half learned, half default.
function fitRecoveryWeights(samples, defaults, { minSamples = 14, prior = 30, ridge = 0.01 } = {}) {
  const keys = Object.keys(defaults);
  const total = keys.reduce((a, k) => a + defaults[k], 0);
  const usable = (samples || []).filter(s => s && s.feel >= 1 && s.feel <= 5 && s.parts);
  const n = usable.length;
  const out = { weights: { ...defaults }, learned: null, n, blend: 0, active: false };
  if (n < minSamples) return out;

  const X = usable.map(s => keys.map(k => (s.parts[k] ?? 50) / 100));
  const y = usable.map(s => Number(s.feel));
  const beta = nonNegativeRidge(X, y, ridge);
  const sum = beta.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return out;

  const learned = Object.fromEntries(keys.map((k, j) => [k, (beta[j] / sum) * total]));
  const blend = n / (n + prior);
  out.weights = Object.fromEntries(keys.map(k => [k, blend * learned[k] + (1 - blend) * defaults[k]]));
  out.learned = learned;
  out.blend = blend;
  out.active = true;
  return out;
}

// Spearman rank correlation (ties get their average rank). null if < 3
// pairs or either side has no spread.
function spearman(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const rank = vals => {
    const order = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(pairs.map(p => p[0])), ry = rank(pairs.map(p => p[1]));
  const m = (rx.length + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const ReadinessModel = { personalBaseline, scoreVsPersonalBaseline, weightedSleepDebt, fitRecoveryWeights, spearman, addDaysISO };

return ReadinessModel;

})();

export default ReadinessModelNS;
