// Rule-based insights — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../src/insights.js');

const RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '../supabase/seed/insight-rules.json'), 'utf8'));

test('every seeded rule is valid and ids are unique', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.deepEqual(I.validateRule(r), [], r.id);
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
    ids.add(r.id);
  }
  assert.ok(RULES.length >= 60);
});

test('conditions: ops, between, exists, missing metrics never match', () => {
  const ctx = { a: 5, b: null };
  assert.equal(I.conditionHolds({ m: 'a', op: 'lt', v: 6 }, ctx), true);
  assert.equal(I.conditionHolds({ m: 'a', op: 'between', v: [5, 6] }, ctx), true);
  assert.equal(I.conditionHolds({ m: 'b', op: 'lt', v: 6 }, ctx), false);
  assert.equal(I.conditionHolds({ m: 'missing', op: 'gt', v: -1 }, ctx), false);
  assert.equal(I.conditionHolds({ m: 'b', op: 'exists', v: false }, ctx), true);
  assert.equal(I.conditionHolds({ m: 'a', op: 'exists', v: true }, ctx), true);
});

test('templates fill numbers, decimals and thousands', () => {
  assert.equal(I.fillTemplate('{a} / {b:1} / {c} / {d}', { a: 4.6, b: 4.56, c: 5600 }), '5 / 4.6 / 5,600 / —');
});

test('a rough morning surfaces the right advice, one per category, by priority', () => {
  const ctx = { hour: 8, recovery: 28, sleep_hrs: 4.6, sleep_need: 9.3, battery: 31, battery_wake: 38,
    battery_charged: 18, rhr_z: 2, rr_z: 1.8, dx_bg: 5.0, dx_trend5: -0.4, dx_bg_age_min: 4,
    strain_target_lo: 0, strain_target_hi: 8 };
  const out = I.evaluateInsights(RULES, ctx, { max: 5 });
  assert.deepEqual(out.map(o => o.id), ['glucose_dropping', 'health_illness_pattern', 'recovery_red', 'sleep_very_short', 'battery_poor_charge']);
  assert.equal(new Set(out.map(o => o.category)).size, out.length);
  assert.match(out[0].title, /5\.0 and falling/);
});

test('the Body Battery popup gets every matching battery rule', () => {
  const ctx = { hour: 9, battery: 82, battery_wake: 85, battery_charged: 55, recovery: 70, battery_rate: 1.5 };
  const out = I.evaluateInsights(RULES, ctx, { max: 10, onePerCategory: false, categories: ['battery'] });
  assert.deepEqual(out.map(o => o.id), ['battery_full_morning', 'battery_great_charge', 'battery_ready_to_train', 'battery_recharging']);
});

test('glucoseMetrics: TIR, lows, overnight, GMI, trend', () => {
  const M = 60000, H = 60 * M, D = 24 * H;
  const midnight = Date.UTC(2026, 9, 24, 0);
  const now = midnight + 9 * H;
  const rs = [];
  for (let t = now - 14 * D; t <= now; t += 5 * M) {
    let v = 7;
    if (t >= midnight + 2 * H && t < midnight + 2.5 * H) v = 3.5;           // 30-min low last night
    if (t >= now - 3 * H && t < now - 2.5 * H) v = 12;                        // a high this morning
    if (t > now - 30 * M) v = 6 - 0.04 * (now - t) / M;                        // rising over the last 30 min
    rs.push({ time: new Date(t).toISOString(), value: v });
  }
  const g = I.glucoseMetrics(rs, now, midnight);
  assert.equal(g.dx_hypos_24h, 1);
  assert.equal(g.dx_night_low, 3.5);
  assert.ok(g.dx_tir_24h > 90 && g.dx_tir_24h < 100);
  assert.ok(g.dx_tir_7d >= 95);
  assert.equal(g.dx_bg_age_min, 0);
  assert.ok(g.dx_gmi > 6 && g.dx_gmi < 6.6, String(g.dx_gmi));
  assert.ok(g.dx_trend5 > 0);
  assert.equal(g.dx_coverage_24h, 100);
  assert.deepEqual(I.glucoseMetrics([], now, midnight), {});
});

test('healthTrendMetrics: a week of suppressed HRV and short nights', () => {
  const day = n => new Date(Date.UTC(2026, 9, 24) - n * 86400000).toISOString().slice(0, 10);
  const hist = [];
  for (let n = 30; n >= 0; n--) {
    const thisWeek = n <= 6;
    hist.push({ log_date: day(n), hrv_ms: thisWeek ? 30 : 45 + (n % 3) * 3, resting_hr: thisWeek ? 66 : 60 + (n % 2), sleep_total_hrs: thisWeek ? 5.5 : 7 });
  }
  const t = I.healthTrendMetrics(hist, day(0));
  assert.ok(t.hrv_trend_7 < -2, String(t.hrv_trend_7));
  assert.ok(t.rhr_trend_7 > 2, String(t.rhr_trend_7));
  assert.equal(t.short_nights_7, 7);
});
