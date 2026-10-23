'use strict';

// Pure helpers for the Food tab's diary — kept out of app.js so they can be
// unit-tested (tests/food-utils.test.js). Diary days are UTC YYYY-MM-DD,
// the same convention as food_log.log_date / todayISO().
(function () {

// iso + n days (n may be negative).
function addDaysISO(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

// Default "logged at" for a new entry on diary day `day`: `now` itself when
// day is today; otherwise that day at now's local time of day — or noon UTC
// if that local time would fall on a different UTC date (log_date is
// derived from logged_at in UTC, so the entry must stay on `day`).
function defaultLoggedAtFor(day, now = new Date()) {
  if (day === now.toISOString().slice(0, 10)) return now;
  const [y, m, d] = day.split('-').map(Number);
  const sameTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes());
  return sameTime.toISOString().slice(0, 10) === day ? sameTime : new Date(Date.UTC(y, m - 1, d, 12));
}

// Newest-first food_log rows -> the first `limit` distinct foods, matched
// on name + brand (case/whitespace-insensitive).
function dedupeRecentFoods(rows, limit = 20) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = `${String(r.food_name || '').trim().toLowerCase()}|${String(r.brand || '').trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length === limit) break;
  }
  return out;
}

const FoodUtils = { addDaysISO, defaultLoggedAtFor, dedupeRecentFoods };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FoodUtils;
} else if (typeof window !== 'undefined') {
  window.FoodUtils = FoodUtils;
}

})();
