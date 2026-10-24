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

// ---- Composer -------------------------------------------------------------

const SAFETY = ['glucose', 'health', 'diabetes'];
const ends = s => /[.!?]$/.test(s);
const sentence = s => (ends(s) ? s : `${s}.`);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// Reasons starting with one of these read straight on from a headline
// ("Recovery 31 after only 4.9h sleep"); others follow a dash.
const JOINS = /^(after|with|on|despite|and|but|as|from|following|plus|so|while)\b/;

// items = evaluateInsights output (highest priority first) with rule parts.
// Body: "<headline> <reason1>, and <reason2>. <Action>." + one line per extra,
// trimmed (second reason, then trailing extras, then the first reason) to
// maxChars. A headline that is already a sentence (the evening bedtime line)
// makes the reasons their own sentence.
function composeBriefing(items, { slot, extras = [], maxChars = 180, headlineOverride = null } = {}) {
  const use = (items || []).filter(i => i && (i.slot === slot || i.slot === 'both'));
  const top = headlineOverride ? null : use.find(i => i.headline);
  const headline = headlineOverride || (top ? top.headline : null);
  const reasonItems = [];
  for (const i of use) {
    if (reasonItems.length >= 2) break;
    if (i === top || !i.reason || reasonItems.some(r => r.category === i.category)) continue;
    reasonItems.push(i);
  }
  const actionItem = use.find(i => i.action && SAFETY.includes(i.category)) || use.find(i => i.action);
  const used = [top, ...reasonItems, actionItem].filter(Boolean);
  const ruleIds = use.filter(i => used.includes(i)).map(i => i.id);

  const build = (reasons, extraLines) => {
    let first;
    if (!headline) first = reasons.length ? sentence(cap(reasons.join(', and '))) : (slot === 'evening' ? 'Nothing new to flag tonight.' : 'Good morning, nothing new to flag today.');
    else if (!reasons.length) first = sentence(headline);
    else if (ends(headline)) first = `${headline} ${sentence(cap(reasons.join(', and ')))}`;
    else first = sentence(`${headline}${JOINS.test(reasons[0]) ? ' ' : ' — '}${reasons.join(', and ')}`);
    const lines = [actionItem ? `${first} ${sentence(actionItem.action)}` : first, ...extraLines];
    return lines.join('\n');
  };
  let reasons = reasonItems.map(i => i.reason);
  let extraLines = (extras || []).filter(Boolean);
  let body = build(reasons, extraLines);
  while (body.length > maxChars && (reasons.length > 1 || extraLines.length)) {
    if (reasons.length > 1) reasons = reasons.slice(0, 1);
    else extraLines = extraLines.slice(0, -1);
    body = build(reasons, extraLines);
  }
  if (body.length > maxChars && reasons.length) body = build([], extraLines);
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1).trimEnd()}…`;

  const base = slot === 'evening' ? '🌙 Evening' : '⚡ Morning';
  const title = top && `${base} · ${top.headline}`.length <= 50 ? `${base} · ${top.headline}` : base;
  return { title, body, ruleIds };
}

// ---- Sleep-data fallback --------------------------------------------------

function londonHHMM(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));
}

// When last night's sleep hasn't synced: what the evening snapshot (battery at
// last app open) and overnight glucose suggest. null if nothing is known.
function fallbackNightPhrase({ snapshot = null, nightGlucose = null } = {}) {
  const snap = snapshot && snapshot.battery != null && snapshot.takenAt ? snapshot : null;
  const g = nightGlucose && Number.isFinite(nightGlucose.low) ? nightGlucose : null;
  if (!snap && !g) return null;
  let s = 'No sleep data from last night yet';
  if (g) s += ` — probably a ${g.low < 3.9 || g.cv > 36 ? 'broken' : 'settled'} night`;
  if (snap) s += ` (bed ~${londonHHMM(snap.takenAt)} on ${Math.round(snap.battery)}%)`;
  if (g) s += g.low < 3.9 ? `, glucose dipped to ${g.low.toFixed(1)}` : g.cv > 36 ? ', glucose up and down' : ', glucose steady';
  return s;
}

const Briefings = { DEFAULT_SCHEDULES, defaultSchedule, scheduleFor, isWeekend, morningTime, eveningTime, isDue,
  composeBriefing, fallbackNightPhrase };

return Briefings;

})();

export default BriefingsNS;
