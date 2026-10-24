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
