// Sleep session classifier and nap credit — run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/sleep-sessions.js');

// Fixtures use UTC as "local" so the tests don't depend on the machine's timezone.
const localDate = ms => new Date(ms).toISOString().slice(0, 10);
const localHour = ms => {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const raw = (start, end, asleepHrs) => ({ start, end, asleepHrs });
const classify = list => S.classifySessions(list, localDate, localHour);

test('night 23:08 to 07:09 plus an afternoon nap: one night and one nap, nap credit 75% of asleep hours', () => {
  const out = classify([
    raw(at(2026, 11, 2, 23, 8), at(2026, 11, 3, 7, 9), 8.0),
    raw(at(2026, 11, 3, 13, 35), at(2026, 11, 3, 16, 2), 2.42),
  ]);
  const night = out.find(s => s.kind === 'night');
  const nap = out.find(s => s.kind === 'nap');
  assert.equal(night.wakeDate, '2026-11-03');
  assert.equal(nap.wakeDate, '2026-11-03');
  assert.equal(out.length, 2);
  assert.ok(Math.abs(S.napDebtCreditHrs([nap]) - 0.75 * 2.42) < 1e-9);
});

test('a sleep that spans midnight is one night', () => {
  const out = classify([raw(at(2026, 11, 2, 23, 59), at(2026, 11, 3, 7, 0), 7)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'night');
  assert.equal(out[0].wakeDate, '2026-11-03');
});

test('a late sleeper with no session ending before noon is still the night', () => {
  const out = classify([raw(at(2026, 11, 2, 23, 30), at(2026, 11, 3, 12, 40), 8)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'night');
});

test('a session with no asleep time is dropped', () => {
  const out = classify([
    raw(at(2026, 11, 2, 23, 0), at(2026, 11, 3, 7, 0), 7),
    raw(at(2026, 11, 3, 10, 0), at(2026, 11, 3, 10, 30), 0),
  ]);
  assert.equal(out.length, 1);
});

test('a session over 14 hours is kept and flagged long; an 11.99 h one is not', () => {
  const long = classify([raw(at(2026, 11, 8, 10, 0), at(2026, 11, 9, 1, 0), 14.5)]);
  assert.equal(long.length, 1);
  assert.equal(long[0].flag, 'long');
  assert.equal(long[0].asleepHrs, 14.5);
  const normal = classify([raw(at(2026, 11, 8, 13, 16), at(2026, 11, 9, 1, 15), 11.99)]);
  assert.equal(normal[0].flag, undefined);
});

test('a doze starting within 2 h after the night is a doze, not a nap', () => {
  const out = classify([
    raw(at(2026, 11, 2, 23, 0), at(2026, 11, 3, 5, 45), 6.5),
    raw(at(2026, 11, 3, 6, 0), at(2026, 11, 3, 7, 10), 1.0),
  ]);
  assert.equal(out.find(s => s.start === at(2026, 11, 3, 6, 0)).kind, 'doze');
});

test('napTonightCreditHrs: 25% of a nap ending by 16:30, capped at 0.5 h; zero if it ends later', () => {
  const night = raw(at(2026, 11, 2, 23, 0), at(2026, 11, 3, 7, 0), 8);
  const naps = classify([night, raw(at(2026, 11, 3, 13, 35), at(2026, 11, 3, 16, 2), 2.42)]).filter(s => s.kind === 'nap');
  assert.equal(naps.length, 1);
  assert.equal(S.napTonightCreditHrs(naps, '2026-11-03'), 0.5);
  const late = classify([night, raw(at(2026, 11, 3, 15, 0), at(2026, 11, 3, 17, 0), 1.0)]).filter(s => s.kind === 'nap');
  assert.equal(S.napTonightCreditHrs(late, '2026-11-03'), 0);
});

test('applyNapCredit: earlier naps cut debt (never below 0); tonight\'s nap cuts tonight\'s need', () => {
  const naps = classify([
    raw(at(2026, 11, 1, 23, 0), at(2026, 11, 2, 7, 0), 8),
    raw(at(2026, 11, 2, 13, 35), at(2026, 11, 2, 16, 2), 2.42),   // debt nap (before today)
    raw(at(2026, 11, 2, 23, 0), at(2026, 11, 3, 7, 0), 8),
    raw(at(2026, 11, 3, 13, 35), at(2026, 11, 3, 16, 2), 2.42),   // tonight's nap (today)
  ]).filter(s => s.kind === 'nap');
  assert.equal(naps.length, 2);
  const r = S.applyNapCredit({ needHours: 9, debtHours: 2.5 }, naps, '2026-11-03');
  assert.ok(Math.abs(r.napDebtCreditHrs - 0.75 * 2.42) < 1e-9);
  assert.ok(Math.abs(r.debtHours - (2.5 - 0.75 * 2.42)) < 1e-9);
  assert.equal(r.napTonightCreditHrs, 0.5);
  assert.equal(r.needHours, 8.5);
  assert.equal(S.applyNapCredit({ needHours: 9, debtHours: 0.5 }, naps, '2026-11-03').debtHours, 0);
});

test('dozePromptNeeded: offered 15 min to 3 h after a set alarm, when no morning sleep is recorded yet', () => {
  const now = at(2026, 11, 3, 6, 45); // 06:45, alarm 05:30
  const none = [];
  const r = S.dozePromptNeeded(now, 5.5, none, localDate, localHour);
  assert.equal(r.needed, true);
  assert.ok(Math.abs(r.suggestedStart - at(2026, 11, 3, 5, 30)) < 1000);
  assert.equal(r.suggestedEnd, now);
});

test('dozePromptNeeded: hidden when no alarm is set, too early, too late, or morning sleep already exists', () => {
  const now = at(2026, 11, 3, 6, 45);
  assert.equal(S.dozePromptNeeded(now, null, [], localDate, localHour).needed, false);
  assert.equal(S.dozePromptNeeded(at(2026, 11, 3, 5, 40), 5.5, [], localDate, localHour).needed, false);
  assert.equal(S.dozePromptNeeded(at(2026, 11, 3, 9, 45), 5.5, [], localDate, localHour).needed, false);
  const doze = classify([
    raw(at(2026, 11, 2, 23, 0), at(2026, 11, 3, 5, 45), 6.5),
    raw(at(2026, 11, 3, 6, 0), at(2026, 11, 3, 7, 10), 1.0),
  ]);
  assert.equal(S.dozePromptNeeded(now, 5.5, doze, localDate, localHour).needed, false);
});
