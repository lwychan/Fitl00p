// GENERATED from src/briefings.js by scripts/sync-shared.mjs — edit that file, not this one.
'use strict';

// Morning & evening briefings — built from insight-rule parts, no AI.
// Schedule maths, the composer, workout comparison, the sleep-data fallback
// phrase, reminder cadence and glucose alert wording. Pure functions, shared
// with the notify-briefings Edge Function via scripts/sync-shared.mjs.
// Times are minutes since local (Europe/London) midnight; weekdays 'Mon'..'Sun'.
// Unit-tested in tests/briefings.test.js.
const BriefingsNS = (function () {

const LEWIS = 'cae63d3e-df60-4415-8a43-64748b6591c3';
const GEMMA = '2c8bf000-b870-4ea1-8a67-ec00ee7d4041';

// Lewis trains ~06:00 on weekdays (wakes 05:30); 05:45 gives sleep time to
// end and Apple Health time to sync.
function defaultSchedule() {
  return { morning: { weekday: '07:30', weekend: '07:30' }, wake: { weekday: '07:30', weekend: '07:30' } };
}
const DEFAULT_SCHEDULES = {
  [LEWIS]: { morning: { weekday: '05:45', weekend: '07:30' }, wake: { weekday: '05:30', weekend: '07:30' } },
  [GEMMA]: defaultSchedule(),
};

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMin = s => { const m = HHMM.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// saved = profiles.briefing_schedule (partial, merged over the default;
// blank or malformed times keep the default).
function scheduleFor(userId, saved) {
  const base = DEFAULT_SCHEDULES[userId] || defaultSchedule();
  const out = {};
  for (const part of ['morning', 'wake']) {
    out[part] = { ...base[part] };
    for (const k of ['weekday', 'weekend']) {
      const v = saved && saved[part] && saved[part][k];
      if (toMin(v) != null) out[part][k] = v;
    }
  }
  return out;
}

const isWeekend = weekday => weekday === 'Sat' || weekday === 'Sun';
const pick = (pair, weekday) => toMin(isWeekend(weekday) ? pair.weekend : pair.weekday);

function morningTime(schedule, weekday) {
  return pick(schedule.morning, weekday);
}

// An hour before suggested bedtime (tomorrow's wake − tonight's sleep need),
// never before 19:00 or after 23:00.
function eveningTime({ needHours, schedule, tomorrowWeekday }) {
  const bed = pick(schedule.wake, tomorrowWeekday) + 1440 - Math.round(needHours * 60);
  return Math.min(1380, Math.max(1140, bed - 60));
}

// Cron runs every 15 min, so a target is due within ±7 min of now.
function isDue(targetMin, nowMin, toleranceMin = 7) {
  return targetMin != null && Math.abs(nowMin - targetMin) <= toleranceMin;
}

const Briefings = { DEFAULT_SCHEDULES, defaultSchedule, scheduleFor, isWeekend, morningTime, eveningTime, isDue };

return Briefings;

})();

export default BriefingsNS;
