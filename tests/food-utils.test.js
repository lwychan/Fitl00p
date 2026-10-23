// Food tab diary helpers — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/food-utils.js');

test('addDaysISO steps whole UTC days, across month/year ends and BST changes', () => {
  assert.equal(F.addDaysISO('2026-10-23', -1), '2026-10-22');
  assert.equal(F.addDaysISO('2026-11-01', -1), '2026-10-31');
  assert.equal(F.addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(F.addDaysISO('2026-10-25', 1), '2026-10-26'); // UK clocks go back on 25 Oct 2026
  assert.equal(F.addDaysISO('2026-03-29', -1), '2026-03-28'); // and forward on 29 Mar
});

test('defaultLoggedAtFor: today returns now unchanged', () => {
  const now = new Date('2026-10-23T09:30:00Z');
  assert.equal(F.defaultLoggedAtFor('2026-10-23', now), now);
});

test('defaultLoggedAtFor: a past day always lands on that UTC day', () => {
  // Every half hour of a day, including local times near midnight that
  // would fall on a neighbouring UTC date in non-UTC timezones.
  for (let mins = 0; mins < 24 * 60; mins += 30) {
    const now = new Date(Date.UTC(2026, 9, 23, 0, mins));
    for (const day of ['2026-10-20', '2026-10-25', '2026-03-29']) {
      const d = F.defaultLoggedAtFor(day, now);
      assert.equal(d.toISOString().slice(0, 10), day, `now=${now.toISOString()} day=${day} -> ${d.toISOString()}`);
    }
  }
});

test('dedupeRecentFoods keeps the newest of each name+brand, up to the limit', () => {
  const rows = [
    { food_name: 'Porridge', brand: 'Oatly', calories_kcal: 300 },
    { food_name: ' porridge ', brand: 'OATLY', calories_kcal: 250 },   // same food, older
    { food_name: 'Porridge', brand: null, calories_kcal: 200 },        // different brand
    { food_name: 'Banana', calories_kcal: 100 },
  ];
  const out = F.dedupeRecentFoods(rows);
  assert.deepEqual(out.map(r => r.calories_kcal), [300, 200, 100]);
  assert.equal(F.dedupeRecentFoods(rows, 2).length, 2);
  assert.deepEqual(F.dedupeRecentFoods(null), []);
});
