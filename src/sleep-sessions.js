// Sleep sessions: classify every sleep session as the night, a doze (a short
// sleep right after the night) or a nap, and work out how much a nap counts
// toward sleep debt and tonight's sleep need. Pure functions — the browser,
// the Edge Function (via _shared/sleep-sessions.ts) and the tests all share
// this one copy. Unit-tested in tests/sleep-sessions.test.js.
//
// Rules (docs/superpowers/specs/2026-11-12-sleep-sessions-design.md):
//   - Night: the longest session ending before 12:00 local on the wake date
//     that starts after 18:00 the day before. If none qualifies, the longest
//     session ending on that wake date (a late sleeper must still get a night).
//   - Doze: a session starting within 2 h after the night ends, same wake date.
//   - Nap: any other session with at least 0.25 h asleep.
//   - Nap debt credit: 75% of asleep hours. Tonight's credit: 25% of asleep
//     hours, capped at 0.5 h, only for a nap that ends by 16:30 on that date.
//   - A session over 14 h is kept but flagged 'long' for review.
(function () {

const MIN_NAP_HRS = 0.25;
const NIGHT_END_CUTOFF_H = 12;
const NIGHT_START_HOUR = 18;
const DOZE_WINDOW_H = 2;
const LONG_SESSION_MS = 14 * 3600000;
const NAP_DEBT_SHARE = 0.75;
const NAP_TONIGHT_SHARE = 0.25;
const NAP_TONIGHT_CAP_HRS = 0.5;
const NAP_TONIGHT_LATEST_END_H = 16.5;

// Previous calendar date for a YYYY-MM-DD string (pure string arithmetic).
function previousDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// Session -> Session with kind/wakeDate/flag. Input order does not matter.
function classifySessions(raw, localDate, localHour) {
  const usable = raw
    .filter(s => s.asleepHrs > 0 && s.end > s.start)
    .map(s => ({ ...s, wakeDate: localDate(s.end), endHour: localHour(s.end) }))
    .sort((a, b) => a.start - b.start);

  const out = [];
  const wakeDates = [...new Set(usable.map(s => s.wakeDate))];
  for (const wakeDate of wakeDates) {
    const sameDay = usable.filter(s => s.wakeDate === wakeDate);
    const prev = previousDate(wakeDate);
    const eligible = sameDay.filter(s =>
      s.endHour < NIGHT_END_CUTOFF_H &&
      localDate(s.start) === prev && localHour(s.start) >= NIGHT_START_HOUR);
    const pool = eligible.length ? eligible : sameDay;
    const night = pool.reduce((best, s) => (!best || s.asleepHrs > best.asleepHrs ? s : best), null);

    const nightEnd = night ? night.end : null;
    for (const s of sameDay) {
      const long = s.end - s.start > LONG_SESSION_MS;
      const flag = long ? { flag: 'long' } : {};
      if (s === night) {
        out.push({ ...stripInternal(s), kind: 'night', ...flag });
      } else if (nightEnd !== null && s.start >= nightEnd && s.start - nightEnd <= DOZE_WINDOW_H * 3600000) {
        out.push({ ...stripInternal(s), kind: 'doze', ...flag });
      } else if (s.asleepHrs >= MIN_NAP_HRS) {
        out.push({ ...stripInternal(s), kind: 'nap', ...flag });
      }
    }
  }
  return out;
}

function stripInternal(s) {
  const { wakeDate, endHour, ...rest } = s;
  return { ...rest, wakeDate, endHour };
}

// Naps (Session[]) -> hours to add to sleep debt repayment.
function napDebtCreditHrs(naps) {
  return NAP_DEBT_SHARE * naps.reduce((sum, n) => sum + n.asleepHrs, 0);
}

// Naps ending on todayDate by 16:30 -> hours off tonight's sleep need.
function napTonightCreditHrs(naps, todayDate) {
  const eligible = naps.filter(n => n.wakeDate === todayDate && n.endHour <= NAP_TONIGHT_LATEST_END_H);
  const raw = NAP_TONIGHT_SHARE * eligible.reduce((sum, n) => sum + n.asleepHrs, 0);
  return Math.min(raw, NAP_TONIGHT_CAP_HRS);
}

// Applies both nap credits to a sleep need. debtNaps are naps before todayDate
// (their 75% reduces debt); tonight's 25% (capped) reduces the need for todayDate.
function applyNapCredit({ needHours, debtHours }, naps, todayDate) {
  const debtNaps = naps.filter(n => n.wakeDate < todayDate);
  const debtCredit = napDebtCreditHrs(debtNaps);
  const tonightCredit = napTonightCreditHrs(naps, todayDate);
  return {
    needHours: Math.max(0, needHours - tonightCredit),
    debtHours: Math.max(0, debtHours - debtCredit),
    napDebtCreditHrs: debtCredit,
    napTonightCreditHrs: tonightCredit,
  };
}

// Should the app offer the one-tap "did you doze after your alarm?" prompt?
// Only in the window 15 min to 3 h after the alarm, with no doze or morning
// sleep already recorded for today. Ignoring it changes nothing.
function dozePromptNeeded(nowMs, alarmHour, sessions, localDate, localHour) {
  const none = { needed: false, suggestedStart: null, suggestedEnd: null };
  if (alarmHour == null) return none;
  const today = localDate(nowMs);
  const nowH = localHour(nowMs);
  if (nowH < alarmHour + 0.25 || nowH > alarmHour + 3) return none;
  const coveredMorning = sessions.some(s =>
    s.wakeDate === today && (s.kind === 'doze' || s.kind === 'night') && s.endHour >= alarmHour - 0.25);
  if (coveredMorning) return none;
  return {
    needed: true,
    suggestedStart: nowMs - (nowH - alarmHour) * 3600000,
    suggestedEnd: nowMs,
  };
}

const SleepSessions = { classifySessions, napDebtCreditHrs, napTonightCreditHrs, dozePromptNeeded, applyNapCredit };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SleepSessions;
} else if (typeof window !== 'undefined') {
  window.SleepSessions = SleepSessions;
}

})();
