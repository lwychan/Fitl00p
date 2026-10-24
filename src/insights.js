'use strict';

// Rule-based insights — replaces the old AI coach briefing with no live AI.
// Rules live in the insight_rules table (source: supabase/seed/insight-rules.json,
// loaded by scripts/build-insight-rules.mjs); each is
//   { id, category, severity, priority, conditions: [{ m, op, v }], title, body }
// and fires when ALL its conditions hold against a context of today's numbers
// (built by buildInsightContext in app.js). Templates fill {metric} or
// {metric:1} (one decimal) from the same context.
// Pure functions — unit-tested in tests/insights.test.js.
(function () {

// Every metric a rule may reference — the test suite checks rules against this.
const METRICS = {
  hour: 'local hour now (0-23)',
  recovery: 'Recovery score 0-100 (50 = your normal)',
  sleep_score: 'Sleep score 0-100',
  sleep_hrs: "last night's sleep, hours",
  sleep_need: 'sleep need tonight, hours',
  sleep_perf: "last night's sleep as % of need",
  sleep_debt: 'sleep debt, hours',
  short_nights_7: 'nights under 6h in the last 7',
  hrv_z: "this morning's HRV vs your normal, SDs",
  rhr_z: "this morning's resting HR vs your normal, SDs (+ = higher)",
  rr_z: 'breathing rate vs your normal, SDs (+ = higher)',
  wrist_temp: 'wrist temperature deviation, °C',
  hrv_trend_7: '7-day mean HRV vs 30-day normal, SDs',
  rhr_trend_7: '7-day mean resting HR vs 30-day normal, SDs',
  strain: "today's strain so far, 0-21",
  strain_yday: "yesterday's strain, 0-21",
  strain_target_lo: "low end of today's strain target",
  strain_target_hi: "high end of today's strain target",
  strain_over: 'strain minus target high (+ = over)',
  battery: 'Body Battery now, %',
  battery_rate: 'Body Battery change, %/hour',
  feel: "today's check-in, 1-5",
  steps: 'steps today',
  steps_goal: 'step goal',
  steps_pct: 'steps as % of goal',
  steps_left: 'steps to goal',
  consumed: 'kcal eaten today',
  eat_target: 'kcal target today',
  consumed_pct: 'eaten as % of target',
  over_kcal: 'kcal over target',
  weekly_net: 'eaten minus burned over the last 7 days, kcal (- = deficit)',
  weekly_net_abs: 'size of weekly_net, kcal',
  weekly_kg: 'weekly_net as kg of body fat (abs)',
  weekly_days: 'days with both eaten and burned data in the last 7',
  food_logged_days_7: 'days food was logged (fitl00p or MFP) in the last 7',
  weight_change_14d: 'weight change over 14 days, kg',
  has_plan: '1 if a weight plan is active',
  days_since_workout: 'days since the last workout',
  workouts_7d: 'workouts in the last 7 days',
  // Body Battery (see src/body-battery.js)
  battery_wake: 'Body Battery when you woke, %',
  battery_bed: 'Body Battery when you went to bed, %',
  battery_charged: 'Body Battery gained overnight, %',
  battery_stress_drain: 'Body Battery lost to stress/activity today, % (positive)',
  battery_ex_drain: 'Body Battery lost to workouts today, % (positive)',
  battery_hrs_to_low: 'hours until 25% at the current drain rate',
  battery_low_hour: 'clock hour Body Battery reaches 25% at this rate',
  // Glucose / diabetes (mmol/L; consensus CGM targets)
  dx_bg: 'latest glucose, mmol/L',
  dx_bg_age_min: 'age of the latest glucose reading, minutes',
  dx_trend5: 'glucose change per 5 min, mmol/L',
  dx_iob: 'insulin on board, units',
  dx_cob: 'carbs on board, g',
  dx_mean_24h: 'mean glucose last 24h',
  dx_tir_24h: '% of last 24h in 3.9-10',
  dx_below_24h: '% of last 24h under 3.9',
  dx_hypos_24h: 'separate lows (<3.9 for 15+ min) in the last 24h',
  dx_coverage_24h: '% of expected sensor readings received in 24h',
  dx_night_low: 'lowest glucose 00:00-06:00 last night',
  dx_night_mean: 'mean glucose 00:00-06:00 last night',
  dx_tir_7d: '% of last 7 days in 3.9-10',
  dx_below_7d: '% of last 7 days under 3.9',
  dx_vlow_7d: '% of last 7 days under 3.0',
  dx_above_7d: '% of last 7 days over 10',
  dx_vhigh_7d: '% of last 7 days over 13.9',
  dx_cv_7d: 'glucose variability (CV) last 7 days, %',
  dx_mean_7d: 'mean glucose last 7 days',
  dx_gmi: 'glucose management indicator (estimated HbA1c), %',
  dx_tir_delta: 'time in range change vs the previous 7 days, points',
};

const HOUR = 3600000, DAY = 24 * HOUR;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = a => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
const isoAddDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// CGM readings [{ time, value }] (value mmol/L) -> the dx_* metrics.
// localMidnightMs = today's local midnight (for "last night" = 00:00-06:00).
// Readings are assumed ~5 min apart (Dexcom/Libre via Nightscout).
function glucoseMetrics(readings, nowMs, localMidnightMs) {
  const rs = (readings || [])
    .map(r => ({ t: typeof r.time === 'number' ? r.time : Date.parse(r.time), v: Number(r.value) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v) && r.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  if (!rs.length) return {};
  const inWin = (from, to) => rs.filter(r => r.t >= from && r.t < to).map(r => r.v);
  const pct = (vals, f) => (vals.length ? (vals.filter(f).length / vals.length) * 100 : null);
  const out = {};

  const last = rs[rs.length - 1];
  out.dx_bg = round1(last.v);
  out.dx_bg_age_min = Math.round((nowMs - last.t) / 60000);
  const recent = rs.filter(r => r.t >= last.t - 20 * 60000);
  if (recent.length >= 3) { // least-squares slope over the last 20 min
    const xs = recent.map(r => (r.t - last.t) / 60000), ys = recent.map(r => r.v);
    const mx = mean(xs), my = mean(ys);
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (den > 0) out.dx_trend5 = round1((num / den) * 5);
  }

  const d1 = inWin(nowMs - DAY, nowMs + 1);
  if (d1.length) {
    out.dx_mean_24h = round1(mean(d1));
    out.dx_tir_24h = Math.round(pct(d1, v => v >= 3.9 && v <= 10));
    out.dx_below_24h = round1(pct(d1, v => v < 3.9));
    out.dx_coverage_24h = Math.min(100, Math.round((d1.length / 288) * 100));
    // Lows: runs of readings under 3.9 lasting 15+ min; a gap >30 min splits runs.
    let hypos = 0, run = null;
    const close = () => { if (run && run.end - run.start >= 15 * 60000) hypos++; run = null; };
    for (const r of rs.filter(r => r.t >= nowMs - DAY)) {
      if (r.v >= 3.9) { close(); continue; }
      if (run && r.t - run.end <= 30 * 60000) run.end = r.t;
      else { close(); run = { start: r.t, end: r.t }; }
    }
    close();
    out.dx_hypos_24h = hypos;
  }

  const night = inWin(localMidnightMs, localMidnightMs + 6 * HOUR);
  if (night.length >= 12) { out.dx_night_low = round1(Math.min(...night)); out.dx_night_mean = round1(mean(night)); }

  const w = inWin(nowMs - 7 * DAY, nowMs + 1);
  if (w.length >= 288) { // at least a day's worth
    const m = mean(w);
    out.dx_mean_7d = round1(m);
    out.dx_tir_7d = Math.round(pct(w, v => v >= 3.9 && v <= 10));
    out.dx_below_7d = round1(pct(w, v => v < 3.9));
    out.dx_vlow_7d = round1(pct(w, v => v < 3.0));
    out.dx_above_7d = Math.round(pct(w, v => v > 10));
    out.dx_vhigh_7d = round1(pct(w, v => v > 13.9));
    out.dx_cv_7d = Math.round((sd(w) / m) * 100);
    out.dx_gmi = round1(3.31 + 0.02392 * m * 18.016); // Bergenstal 2018, mean in mg/dL
    const prev = inWin(nowMs - 14 * DAY, nowMs - 7 * DAY);
    if (prev.length >= 288) out.dx_tir_delta = out.dx_tir_7d - Math.round(pct(prev, v => v >= 3.9 && v <= 10));
  }
  return out;
}

// health_daily rows -> 7-day trends vs the weeks before, plus short nights.
// SD-based like Recovery: HRV on a log scale. Needs 10+ baseline days.
function healthTrendMetrics(history, todayIso) {
  const rows = (history || []).filter(h => h.log_date <= todayIso);
  const weekFrom = isoAddDays(todayIso, -6);
  const week = rows.filter(h => h.log_date >= weekFrom);
  const base = rows.filter(h => h.log_date < weekFrom && h.log_date >= isoAddDays(todayIso, -37));
  const out = {};
  const trend = (field, log) => {
    const f = h => Number(h[field]);
    const ok = h => h[field] != null && Number.isFinite(f(h)) && (!log || f(h) > 0);
    const tx = v => (log ? Math.log(v) : v);
    const b = base.filter(ok).map(h => tx(f(h))), wk = week.filter(ok).map(h => tx(f(h)));
    if (b.length < 10 || wk.length < 4) return null;
    return round1((mean(wk) - mean(b)) / Math.max(sd(b), log ? 0.05 : 1));
  };
  out.hrv_trend_7 = trend('hrv_ms', true);
  out.rhr_trend_7 = trend('resting_hr', false);
  const nights = week.filter(h => h.sleep_total_hrs != null && Number(h.sleep_total_hrs) >= 2);
  if (nights.length >= 3) out.short_nights_7 = nights.filter(h => Number(h.sleep_total_hrs) < 6).length;
  return out;
}

const OPS = {
  lt: (x, v) => x < v,
  lte: (x, v) => x <= v,
  gt: (x, v) => x > v,
  gte: (x, v) => x >= v,
  eq: (x, v) => x === v,
  ne: (x, v) => x !== v,
  between: (x, v) => x >= v[0] && x <= v[1],
};

function conditionHolds(c, ctx) {
  const x = ctx[c.m];
  if (c.op === 'exists') return c.v ? x != null : x == null;
  if (x == null || !Number.isFinite(Number(x))) return false;
  const f = OPS[c.op];
  return !!f && f(Number(x), c.v);
}

function fillTemplate(text, ctx) {
  return String(text || '').replace(/\{(\w+)(?::(\d))?\}/g, (whole, key, dp) => {
    const v = ctx[key];
    if (v == null) return '—';
    if (typeof v !== 'number') return String(v);
    const n = dp ? v.toFixed(Number(dp)) : Math.round(v).toString();
    return Math.abs(v) >= 1000 && !dp ? Number(n).toLocaleString('en-GB') : n;
  });
}

// Briefing parts: filled like a template, but null when absent or when any
// value it needs is missing (a briefing never shows "—").
function fillPart(text, ctx) {
  if (!text) return null;
  for (const [, key] of String(text).matchAll(/\{(\w+)(?::\d)?\}/g)) if (ctx[key] == null) return null;
  return fillTemplate(text, ctx);
}

const SLOTS = ['app', 'morning', 'evening', 'both'];

// Matching rules, highest priority first, each filled in from ctx.
// onePerCategory keeps only the top rule of each category (the dashboard
// card); `categories` limits to those (the Body Battery popup).
function evaluateInsights(rules, ctx, { max = 4, onePerCategory = true, categories = null } = {}) {
  const hits = (rules || [])
    .filter(r => r && r.enabled !== false && Array.isArray(r.conditions) && r.conditions.length
      && (!categories || categories.includes(r.category))
      && r.conditions.every(c => conditionHolds(c, ctx)))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.id).localeCompare(String(b.id)));
  const seen = new Set();
  const out = [];
  for (const r of hits) {
    if (onePerCategory && seen.has(r.category)) continue;
    seen.add(r.category);
    out.push({ id: r.id, category: r.category, severity: r.severity, priority: r.priority,
      title: fillTemplate(r.title, ctx), body: fillTemplate(r.body, ctx),
      headline: fillPart(r.headline, ctx), reason: fillPart(r.reason, ctx), action: fillPart(r.action, ctx),
      slot: r.slot || 'app' });
    if (out.length >= max) break;
  }
  return out;
}

// Problems with a rule, [] if fine (used by tests and the seed builder).
function validateRule(r) {
  const errs = [];
  if (!r.id) errs.push('missing id');
  if (!['good', 'info', 'caution', 'warn'].includes(r.severity)) errs.push(`bad severity ${r.severity}`);
  if (!Array.isArray(r.conditions) || !r.conditions.length) errs.push('no conditions');
  for (const c of r.conditions || []) {
    if (!(c.m in METRICS)) errs.push(`unknown metric ${c.m}`);
    if (c.op !== 'exists' && !(c.op in OPS)) errs.push(`unknown op ${c.op}`);
    if (c.op === 'between' && !(Array.isArray(c.v) && c.v.length === 2)) errs.push(`between needs [lo, hi] for ${c.m}`);
  }
  if (r.slot != null && !SLOTS.includes(r.slot)) errs.push(`bad slot ${r.slot}`);
  for (const [, key] of `${r.title} ${r.body} ${r.headline || ''} ${r.reason || ''} ${r.action || ''}`.matchAll(/\{(\w+)(?::\d)?\}/g)) {
    if (!(key in METRICS)) errs.push(`unknown template key ${key}`);
  }
  return errs;
}

// Day-level numbers for the rules: steps, food vs target, the last 7
// complete days' calorie balance, 14-day weight change, workout frequency.
// history = health_daily rows (with cal_fitl00p / cal_mfp merged in);
// weights = [{ log_date, weight (kg) }]; workouts = [{ workout_type, started_at }].
function dailyContextMetrics({ day, nowMs, history = [], weights = [], workouts = [], steps, stepsGoal = 10000, consumed, eatTarget, hasPlan }) {
  const out = {};
  if (steps != null && Number.isFinite(Number(steps))) {
    out.steps = Number(steps); out.steps_goal = stepsGoal;
    out.steps_pct = Math.round((out.steps / stepsGoal) * 100);
    out.steps_left = Math.max(0, stepsGoal - out.steps);
  }
  if (consumed != null && consumed > 0) out.consumed = Math.round(consumed);
  if (eatTarget) {
    out.eat_target = Math.round(eatTarget);
    if (out.consumed != null) {
      out.consumed_pct = Math.round((out.consumed / eatTarget) * 100);
      out.over_kcal = Math.max(0, out.consumed - out.eat_target);
    }
  }
  let net = 0, days = 0;
  for (const h of history.filter(h => h.log_date < day && h.log_date >= isoAddDays(day, -7))) {
    const eaten = h.cal_fitl00p ?? h.cal_mfp ?? h.dietary_energy_kcal;
    if (eaten == null || h.active_energy_kcal == null || h.resting_energy_kcal == null) continue;
    net += Number(eaten) - (Number(h.active_energy_kcal) + Number(h.resting_energy_kcal));
    days++;
  }
  if (days) {
    out.weekly_days = days;
    out.weekly_net = Math.round(net);
    out.weekly_net_abs = Math.abs(out.weekly_net);
    out.weekly_kg = round1(Math.abs(net) / 7700);
  }
  out.food_logged_days_7 = history.filter(h => h.log_date < day && h.log_date >= isoAddDays(day, -7) && (Number(h.cal_fitl00p) > 0 || Number(h.cal_mfp) > 0)).length;
  out.has_plan = hasPlan ? 1 : 0;
  const from = isoAddDays(day, -14);
  const pts = [...weights.map(w => ({ d: w.log_date, kg: Number(w.weight) })),
    ...history.filter(h => h.weight_kg != null).map(h => ({ d: h.log_date, kg: Number(h.weight_kg) }))]
    .filter(p => p.d >= from && p.d <= day && Number.isFinite(p.kg)).sort((a, b) => a.d.localeCompare(b.d));
  if (pts.length >= 2 && Date.parse(pts[pts.length - 1].d) - Date.parse(pts[0].d) >= 7 * DAY) {
    out.weight_change_14d = round1(pts[pts.length - 1].kg - pts[0].kg);
  }
  const real = workouts.filter(w => !/walk/i.test(w.workout_type || '') && Number.isFinite(Date.parse(w.started_at)))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  if (real.length) {
    out.days_since_workout = Math.floor((nowMs - Date.parse(real[0].started_at)) / DAY);
    out.workouts_7d = real.filter(w => nowMs - Date.parse(w.started_at) < 7 * DAY).length;
  }
  return out;
}

// Body Battery numbers for the rules, from a simulate() result.
// wakeLevel = level when last night's sleep ended (null if no night found).
function batteryContextMetrics({ level, result, hasNight, wakeLevel, hourNow }) {
  if (level == null || !result) return {};
  const rate = result.ratePerHr;
  const out = {
    battery: Math.round(level),
    battery_rate: round1(rate),
    battery_stress_drain: Math.round(Math.max(0, -result.parts.stress)),
    battery_ex_drain: Math.round(Math.max(0, -result.parts.exercise)),
  };
  if (hasNight) {
    out.battery_bed = Math.round(result.levelAtBreakdown);
    out.battery_charged = Math.round(result.parts.sleep);
    if (wakeLevel != null) out.battery_wake = Math.round(wakeLevel);
  }
  if (rate < -0.3 && level > 25) {
    out.battery_hrs_to_low = round1((level - 25) / -rate);
    const at = hourNow + out.battery_hrs_to_low;
    if (at < 24) out.battery_low_hour = Math.floor(at);
  }
  return out;
}

const Insights = { dailyContextMetrics, batteryContextMetrics, METRICS, evaluateInsights, conditionHolds, fillTemplate, validateRule, glucoseMetrics, healthTrendMetrics };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Insights;
} else if (typeof window !== 'undefined') {
  window.Insights = Insights;
}

})();
