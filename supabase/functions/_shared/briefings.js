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
// "after X, and Y" — unless a reason already carries its own "and".
const joinReasons = rs => rs.join(rs.some(r => /^and\b/.test(r)) ? ', ' : ', and ');

// items = evaluateInsights output (highest priority first) with rule parts.
// Body: "<headline> <reason1>, and <reason2>. <Action>." + one line per extra,
// trimmed (second reason, then trailing extras, then the first reason) to
// maxChars. pinned lines (e.g. "sleep hasn't synced") are never dropped. A headline that is already a sentence (the evening bedtime line)
// makes the reasons their own sentence.
function composeBriefing(items, { slot, extras = [], pinned = [], maxChars = 180, headlineOverride = null } = {}) {
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
    if (!headline) first = reasons.length ? sentence(cap(joinReasons(reasons))) : (slot === 'evening' ? 'Nothing new to flag tonight.' : 'Good morning, nothing new to flag today.');
    else if (!reasons.length) first = sentence(headline);
    else if (ends(headline)) first = `${headline} ${sentence(cap(joinReasons(reasons)))}`;
    else first = sentence(`${headline}${JOINS.test(reasons[0]) ? ' ' : ' — '}${joinReasons(reasons)}`);
    const lines = [actionItem ? `${first} ${sentence(actionItem.action)}` : first, ...(pinned || []).filter(Boolean), ...extraLines];
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
// Sleep under 3h in the morning is almost always a partial sync, not a real night.
const sleepSynced = hrs => hrs != null && Number(hrs) >= 3;

function fallbackNightPhrase({ snapshot = null, nightGlucose = null, partialHrs = null } = {}) {
  const snap = snapshot && snapshot.battery != null && snapshot.takenAt ? snapshot : null;
  const g = nightGlucose && Number.isFinite(nightGlucose.low) ? nightGlucose : null;
  if (!snap && !g && partialHrs == null) return null;
  let s = partialHrs != null ? `Only ${Number(partialHrs).toFixed(1)}h of last night's sleep has synced so far`
    : 'No sleep data from last night yet';
  if (g) s += ` — probably a ${g.low < 3.9 || g.cv > 36 ? 'broken' : 'settled'} night`;
  if (snap) s += ` (bed ~${londonHHMM(snap.takenAt)} on ${Math.round(snap.battery)}%)`;
  if (g) s += g.low < 3.9 ? `, glucose dipped to ${g.low.toFixed(1)}` : g.cv > 36 ? ', glucose up and down' : ', glucose steady';
  return s;
}

// ---- Hevy workout line ----------------------------------------------------

const kg = n => (Math.round(n * 10) / 10).toLocaleString('en-GB');
const shortName = t => String(t || '').replace(/\s*\([^)]*\)\s*$/, '');

// Hevy writes "Squat (Barbell)", fitl00p "Barbell Squat" or plain "Hip
// Thrust": two names match when all their words match, or their names
// without the bracketed equipment match.
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
function sameExercise(a, b) {
  const full = s => words(s).sort().join(' ');
  const base = s => words(shortName(s)).join(' ');
  return full(a) === full(b) || base(a) === base(b) || base(a) === full(b) || full(a) === base(b);
}

const LB = 0.45359237;
// A fitl00p-logged session (workout_sessions + workout_exercises +
// workout_sets) in the same shape as a hevy_workouts row, in kg.
function fitl00pSessionRow(session, exercises) {
  let volume = 0;
  const ex = (exercises || []).map(e => {
    const sets = e.sets || [];
    const kgs = sets.map(s => (Number(s.weight) || 0) * (s.unit === 'lb' ? LB : 1));
    sets.forEach((s, i) => { if (kgs[i] > 0 && s.reps > 0) volume += kgs[i] * s.reps; });
    const top = Math.max(0, ...kgs);
    return { title: e.name, sets: sets.length, top_kg: top > 0 ? Math.round(top * 10) / 10 : null };
  });
  return { id: session.id, title: session.split_type || 'Workout', routine_id: `fitl00p:${session.split_type || ''}`,
    started_at: session.started_at, volume_kg: Math.round(volume), exercises: ex };
}

// today = this session; previous = the last session of the same routine (or
// null); history = earlier sessions from Hevy and fitl00p, newest first, used
// for top sets when the same routine hasn't been done before. Only gains are
// mentioned — never "+0" or a drop.
function workoutLine(today, previous, history = []) {
  if (!today) return null;
  let line = `🏋️ ${today.title || 'Workout'}: ${kg(Number(today.volume_kg) || 0)} kg`;
  if (previous) {
    const dVol = Math.round((Number(today.volume_kg) || 0) - (Number(previous.volume_kg) || 0));
    if (dVol > 0) line += `, +${kg(dVol)} kg on last time`;
  }
  const lastTop = title => {
    for (const row of [previous, ...(history || [])].filter(Boolean)) {
      const hit = (row.exercises || []).find(e => sameExercise(e.title, title) && e.top_kg != null);
      if (hit) return hit.top_kg;
    }
    return null;
  };
  let best = null;
  for (const e of today.exercises || []) {
    const before = lastTop(e.title);
    if (e.top_kg == null || before == null) continue;
    const gain = e.top_kg - before;
    if (gain > 0 && (!best || gain > best.gain)) best = { name: shortName(e.title), gain };
  }
  if (best) line += `; ${best.name} top set +${kg(best.gain)} kg`;
  return line;
}

// ---- Morning reminders & helpers -------------------------------------------

const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Gemma weighs in daily; Lewis on his weigh-in days (notification_prefs
// 'weighin'.days_of_week, default Tuesday). Never once logged today.
function weighinDue({ isGemma, weekday, days, loggedToday }) {
  if (loggedToday) return false;
  return isGemma || (days && days.length ? days : [2]).includes(WEEKDAY_NUM[weekday]);
}

function morningExtras({ weighinDue: w, tirzepatideDue, peptideDue }) {
  return [w && '⚖️ Weigh-in day.', tirzepatideDue && '💉 Tirzepatide due today.', peptideDue && '💉 Peptide dose today.']
    .filter(Boolean);
}

// UTC ms of 00:00 London on dateStr (YYYY-MM-DD), BST or GMT.
function londonMidnightMs(dateStr) {
  const utc = Date.parse(`${dateStr}T00:00:00Z`);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(utc)));
  return utc - (h > 12 ? h - 24 : h) * 3600000;
}

// Overnight CGM summary for the sleep fallback; null with under an hour of readings.
function nightGlucoseSummary(readings, fromMs, toMs) {
  const v = (readings || []).filter(r => r.time >= fromMs && r.time < toMs).map(r => Number(r.value)).filter(Number.isFinite);
  if (v.length < 12) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  return { low: Math.round(Math.min(...v) * 10) / 10, mean: Math.round(mean * 10) / 10, cv: Math.round((sd / mean) * 100) };
}

const Briefings = { sleepSynced, weighinDue, morningExtras, londonMidnightMs, nightGlucoseSummary, workoutLine, sameExercise, fitl00pSessionRow, DEFAULT_SCHEDULES, defaultSchedule, scheduleFor, isWeekend, morningTime, eveningTime, isDue,
  composeBriefing, fallbackNightPhrase };

return Briefings;

})();

export default BriefingsNS;
