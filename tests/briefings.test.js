// Morning/evening briefings — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/briefings.js');

const LEWIS = 'cae63d3e-df60-4415-8a43-64748b6591c3';
const GEMMA = '2c8bf000-b870-4ea1-8a67-ec00ee7d4041';

const london = iso => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour), minute: Number(p.minute) };
};

test('morning times: Lewis 05:45 weekdays / 07:30 weekends, Gemma 07:30', () => {
  assert.equal(B.morningTime(B.scheduleFor(LEWIS), 'Tue'), 345);
  assert.equal(B.morningTime(B.scheduleFor(LEWIS), 'Sat'), 450);
  assert.equal(B.morningTime(B.scheduleFor(GEMMA), 'Tue'), 450);
  assert.equal(B.morningTime(B.scheduleFor('someone-else'), 'Sun'), 450);
  assert.equal(B.isWeekend('Sun'), true);
  assert.equal(B.isWeekend('Fri'), false);
});

test('saved schedule overrides the default', () => {
  const s = B.scheduleFor(LEWIS, { morning: { weekday: '06:15' } });
  assert.equal(B.morningTime(s, 'Mon'), 375);
  assert.equal(B.morningTime(s, 'Sat'), 450);
});

test('evening time: an hour before bedtime, clamped to 19:00-23:00', () => {
  const s = B.scheduleFor(LEWIS);
  assert.equal(B.eveningTime({ needHours: 8.4, schedule: s, tomorrowWeekday: 'Wed' }), 1206);
  assert.equal(B.eveningTime({ needHours: 8, schedule: s, tomorrowWeekday: 'Sat' }), 1350);
  assert.equal(B.eveningTime({ needHours: 12, schedule: s, tomorrowWeekday: 'Wed' }), 1140);
});

test('isDue within a 7-minute window', () => {
  assert.equal(B.isDue(345, 352), true);
  assert.equal(B.isDue(345, 353), false);
});

test('05:45 London fires on both sides of the clock change', () => {
  for (const iso of ['2026-10-26T05:45:00Z', '2026-10-23T04:45:00Z']) {
    const p = london(iso);
    assert.equal(p.hour, 5); assert.equal(p.minute, 45);
    assert.equal(B.isDue(B.morningTime(B.scheduleFor(LEWIS), p.weekday), p.hour * 60 + p.minute), true, iso);
  }
});

const item = (id, category, priority, parts, slot = 'morning', severity = 'info') =>
  ({ id, category, priority, severity, slot, headline: null, reason: null, action: null, ...parts });
const ROUGH = [
  item('recovery_red', 'recovery', 90, { headline: 'Recovery 31', action: 'Take it easy — light walk today' }, 'morning', 'warn'),
  item('sleep_very_short', 'sleep', 80, { reason: 'after only 4.9h sleep' }),
  item('trend_hrv_down', 'trend', 70, { reason: "HRV's been down all week" }),
];

test('composer: rough morning reads headline, two reasons, one action', () => {
  const b = B.composeBriefing(ROUGH, { slot: 'morning' });
  assert.ok(b.body.startsWith("Recovery 31 after only 4.9h sleep, and HRV's been down all week. Take it easy — light walk today."), b.body);
  assert.equal(b.title, '⚡ Morning · Recovery 31');
  assert.deepEqual(b.ruleIds, ['recovery_red', 'sleep_very_short', 'trend_hrv_down']);
});

test('composer: good morning with a weigh-in extra', () => {
  const b = B.composeBriefing([item('recovery_green', 'recovery', 60,
    { headline: "You've recovered well (78)", action: 'Push hard today' }, 'both', 'good')],
  { slot: 'morning', extras: ['⚖️ Weigh-in day.'] });
  assert.equal(b.body, "You've recovered well (78). Push hard today.\n⚖️ Weigh-in day.");
});

test('composer: app-only items ignored; safety action outranks training advice', () => {
  const b = B.composeBriefing([
    item('recovery_green', 'recovery', 90, { headline: 'Recovered (80)', action: 'Push hard today' }),
    item('glucose_low_night', 'glucose', 10, { action: 'Have a snack before training' }),
    item('app_only', 'sleep', 95, { headline: 'Should not show', reason: 'nor this' }, 'app'),
  ], { slot: 'morning' });
  assert.equal(b.body, 'Recovered (80). Have a snack before training.');
});

test('composer: never longer than 180 characters', () => {
  const long = 'x'.repeat(60);
  const b = B.composeBriefing([
    item('a', 'recovery', 9, { headline: 'Recovery 31', action: long }),
    item('b', 'sleep', 8, { reason: long }), item('c', 'trend', 7, { reason: long }),
  ], { slot: 'morning', extras: [long, long] });
  assert.ok(b.body.length <= 180, b.body.length);
});

test('composer: evening headline override starts the body', () => {
  const b = B.composeBriefing([item('strain_x', 'strain', 50, { headline: 'Big day', reason: 'strain 14.2, over target' }, 'evening')],
    { slot: 'evening', headlineOverride: 'In bed by 21:06.' });
  assert.ok(b.body.startsWith('In bed by 21:06. Strain 14.2, over target.'), b.body);
});

test('composer: nothing known still gives a clean sentence', () => {
  const b = B.composeBriefing([], { slot: 'morning' });
  assert.ok(b.body.length > 5);
  assert.doesNotMatch(b.body + b.title, /undefined|NaN|—/);
});

test('fallback phrase only says what is known', () => {
  assert.equal(B.fallbackNightPhrase({}), null);
  assert.equal(B.fallbackNightPhrase({ snapshot: { battery: 32, takenAt: '2026-10-23T22:40:00Z' },
    nightGlucose: { low: 5.1, mean: 6.8, cv: 18 } }),
  'No sleep data from last night yet — probably a settled night (bed ~23:40 on 32%), glucose steady');
  assert.equal(B.fallbackNightPhrase({ nightGlucose: { low: 3.4, mean: 6, cv: 30 } }),
    'No sleep data from last night yet — probably a broken night, glucose dipped to 3.4');
  assert.equal(B.fallbackNightPhrase({ snapshot: { battery: 40, takenAt: '2026-10-23T22:40:00Z' } }),
    'No sleep data from last night yet (bed ~23:40 on 40%)');
});
