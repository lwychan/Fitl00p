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

test('composer: a reason that is not a joining clause follows a dash', () => {
  const b = B.composeBriefing([
    item('recovery_normal', 'recovery', 30, { headline: 'Recovery 55' }),
    item('trend_hrv_down', 'trend', 70, { reason: "HRV's been down all week" }),
  ], { slot: 'morning' });
  assert.equal(b.body, "Recovery 55 — HRV's been down all week.");
});

const UPPER = (volume, press, row = 80) => ({ title: 'Wk1-4 Upper B (Fri)', routine_id: 'r1', volume_kg: volume,
  exercises: [{ title: 'Shoulder Press (Dumbbell)', sets: 3, top_kg: press }, { title: 'Seated Row (Cable)', sets: 3, top_kg: row }] });

test('workout line: volume gain and the biggest top-set increase', () => {
  assert.equal(B.workoutLine(UPPER(7360, 60), UPPER(7265, 57.5)),
    '🏋️ Wk1-4 Upper B (Fri): 7,360 kg, +95 kg on last time; Shoulder Press top set +2.5 kg');
});

test('workout line: no comparison when there is no earlier session or no gain', () => {
  assert.equal(B.workoutLine(UPPER(7360, 60), null), '🏋️ Wk1-4 Upper B (Fri): 7,360 kg');
  assert.equal(B.workoutLine(UPPER(6800, 55, 75), UPPER(7265, 57.5)), '🏋️ Wk1-4 Upper B (Fri): 6,800 kg');
  assert.equal(B.workoutLine(null, UPPER(7265, 57.5)), null);
  const noTop = { ...UPPER(7400, null), exercises: [{ title: 'Plank', sets: 3, top_kg: null }] };
  assert.equal(B.workoutLine(noTop, UPPER(7265, 57.5)), '🏋️ Wk1-4 Upper B (Fri): 7,400 kg, +135 kg on last time');
});

test('fitl00p sessions become workout rows in kg', () => {
  const row = B.fitl00pSessionRow({ id: 's1', split_type: 'Push', started_at: '2026-08-20T06:00:00Z' }, [
    { name: 'Machine Chest Press', sets: [{ reps: 10, weight: 100, unit: 'lb' }, { reps: 8, weight: 110, unit: 'lb' }] },
    { name: 'Plank', sets: [{ reps: 1, weight: 0, unit: 'kg' }] },
  ]);
  assert.equal(row.title, 'Push');
  assert.equal(row.routine_id, 'fitl00p:Push');
  assert.equal(row.volume_kg, Math.round((1000 + 880) * 0.45359237));
  assert.equal(row.exercises[0].top_kg, Math.round(110 * 0.45359237 * 10) / 10);
  assert.equal(row.exercises[0].sets, 2);
  assert.equal(row.exercises[1].top_kg, null);
});

test('exercise names match across Hevy and fitl00p', () => {
  assert.equal(B.sameExercise('Squat (Barbell)', 'Barbell Squat'), true);
  assert.equal(B.sameExercise('Hip Thrust (Barbell)', 'Hip Thrust'), true);
  assert.equal(B.sameExercise('Hammer Curl (Dumbbell)', 'Hammer Curl'), true);
  assert.equal(B.sameExercise('Bench Press (Barbell)', 'Dumbbell Bench Press'), false);
});

test('workout line: top set compared with that exercise last time in either app', () => {
  const today = { title: 'Wk1-4 Lower A (Mon)', routine_id: 'r9', volume_kg: 5000,
    exercises: [{ title: 'Squat (Barbell)', sets: 3, top_kg: 100 }, { title: 'Hip Thrust (Barbell)', sets: 3, top_kg: 120 }] };
  const history = [
    { title: 'Legs', routine_id: 'fitl00p:Legs', volume_kg: 4000, exercises: [{ title: 'Barbell Squat', sets: 3, top_kg: 95 }, { title: 'Hip Thrust', sets: 3, top_kg: 110 }] },
    { title: 'Legs', routine_id: 'fitl00p:Legs', volume_kg: 3000, exercises: [{ title: 'Barbell Squat', sets: 3, top_kg: 80 }] },
  ];
  assert.equal(B.workoutLine(today, null, history), '🏋️ Wk1-4 Lower A (Mon): 5,000 kg; Hip Thrust top set +10 kg');
});

test('morning extras: weigh-in, Tirzepatide and peptide lines', () => {
  assert.deepEqual(B.morningExtras({ weighinDue: true, tirzepatideDue: false, peptideDue: false }), ['⚖️ Weigh-in day.']);
  assert.deepEqual(B.morningExtras({ weighinDue: false, tirzepatideDue: false, peptideDue: false }), []);
  assert.deepEqual(B.morningExtras({ weighinDue: true, tirzepatideDue: true, peptideDue: true }),
    ['⚖️ Weigh-in day.', '💉 Tirzepatide due today.', '💉 Peptide dose today.']);
});

test('weigh-in due: Gemma daily, Lewis on his weigh-in days, never once logged', () => {
  assert.equal(B.weighinDue({ isGemma: true, weekday: 'Thu', days: null, loggedToday: false }), true);
  assert.equal(B.weighinDue({ isGemma: false, weekday: 'Tue', days: null, loggedToday: false }), true);
  assert.equal(B.weighinDue({ isGemma: false, weekday: 'Wed', days: null, loggedToday: false }), false);
  assert.equal(B.weighinDue({ isGemma: false, weekday: 'Fri', days: [5], loggedToday: false }), true);
  assert.equal(B.weighinDue({ isGemma: true, weekday: 'Thu', days: null, loggedToday: true }), false);
});

test('London midnight in UTC on both sides of the clock change', () => {
  assert.equal(new Date(B.londonMidnightMs('2026-10-24')).toISOString(), '2026-10-23T23:00:00.000Z');
  assert.equal(new Date(B.londonMidnightMs('2026-10-26')).toISOString(), '2026-10-26T00:00:00.000Z');
});

test('night glucose summary 00:00-06:00', () => {
  const from = Date.UTC(2026, 9, 26), H = 3600000;
  const rs = Array.from({ length: 72 }, (_, i) => ({ time: from + i * 5 * 60000, value: i === 30 ? 3.5 : 6 }));
  const g = B.nightGlucoseSummary(rs, from, from + 6 * H);
  assert.equal(g.low, 3.5);
  assert.equal(g.mean, 6);
  assert.equal(B.nightGlucoseSummary(rs.slice(0, 5), from, from + 6 * H), null);
});

test('under 3h of sleep counts as not fully synced and says how much arrived', () => {
  assert.equal(B.sleepSynced(1.38), false);
  assert.equal(B.sleepSynced(null), false);
  assert.equal(B.sleepSynced(5.2), true);
  assert.equal(B.fallbackNightPhrase({ partialHrs: 1.38 }), 'Only 1.4h of last night\'s sleep has synced so far');
  assert.equal(B.fallbackNightPhrase({ partialHrs: 1.38, nightGlucose: { low: 5, mean: 6, cv: 10 } }),
    'Only 1.4h of last night\'s sleep has synced so far — probably a settled night, glucose steady');
});

test('composer: a reason starting "and" is not doubled up', () => {
  const b = B.composeBriefing([
    item('sleep_short', 'sleep', 78, { headline: 'Short night: 5.5h' }),
    item('recovery_below', 'recovery', 60, { reason: "and Recovery's only 37" }),
    item('trend_hrv_down', 'trend', 50, { reason: "HRV's been down all week" }),
  ], { slot: 'morning' });
  assert.equal(b.body, "Short night: 5.5h and Recovery's only 37, HRV's been down all week.");
});

test('composer: a pinned note (sleep not synced) survives trimming; reasons go first', () => {
  const note = "Only 1.4h of last night's sleep has synced so far — probably a settled night, glucose steady.";
  const b = B.composeBriefing([
    item('recovery_below', 'recovery', 60, { headline: 'Recovery 36', action: 'Train, but go lighter — technique work, fewer hard sets' }),
    item('nutrition_weekly_on_track', 'nutrition', 20, { reason: 'on a steady 5,132 kcal deficit this week' }),
  ], { slot: 'morning', pinned: [note], extras: ['💉 Tirzepatide due today.'] });
  assert.ok(b.body.includes(note), b.body);
  assert.ok(b.body.length <= 180, b.body.length);
  assert.ok(b.body.startsWith('Recovery 36. Train, but go lighter'), b.body);
});

test('bedtime line: wake minus sleep need, with the main reason', () => {
  assert.equal(B.bedtimeLine({ needHours: 8.4, wakeMin: 330, strainHours: 0.1, debtHours: 1.2 }),
    'In bed by 21:06 (8.4h — catching up on sleep debt).');
  assert.equal(B.bedtimeLine({ needHours: 8.6, wakeMin: 450, strainHours: 0.6, debtHours: 0 }),
    "In bed by 22:54 (8.6h — after today's strain).");
  assert.equal(B.bedtimeLine({ needHours: 8, wakeMin: 450, strainHours: 0, debtHours: 0 }), 'In bed by 23:30 (8h).');
});

test('evening: the bedtime line leads, and no Body Battery mention without a snapshot', () => {
  const I = require('../src/insights.js');
  const rules = [{ id: 'battery_evening_low', category: 'battery', severity: 'info', priority: 50, slot: 'evening',
    conditions: [{ m: 'battery', op: 'between', v: [26, 30] }], title: 't', body: 'b', reason: 'Body Battery {battery}%' }];
  const without = B.composeBriefing(I.evaluateInsights(rules, { hour: 20 }), { slot: 'evening', headlineOverride: 'In bed by 21:06.' });
  assert.equal(without.body, 'In bed by 21:06.');
  const withSnap = B.composeBriefing(I.evaluateInsights(rules, { hour: 20, battery: 28 }), { slot: 'evening', headlineOverride: 'In bed by 21:06.' });
  assert.equal(withSnap.body, 'In bed by 21:06. Body Battery 28%.');
});

test('wake time for tomorrow: Lewis 05:30 weekdays, 07:30 weekends', () => {
  assert.equal(B.wakeTime(B.scheduleFor(LEWIS), 'Mon'), 330);
  assert.equal(B.wakeTime(B.scheduleFor(LEWIS), 'Sun'), 450);
  assert.equal(B.wakeTime(B.scheduleFor(GEMMA), 'Mon'), 450);
});

test('Tirzepatide nudges 12:00/15:00/17:00/19:00 only until logged, each once', () => {
  const base = { nudgeMinutes: B.TIRZEPATIDE_NUDGE_MINUTES, loggedToday: false, sentKinds: [], kind: 'tirzepatide_nudge' };
  assert.deepEqual(B.TIRZEPATIDE_NUDGE_MINUTES, [720, 900, 1020, 1140]);
  assert.equal(B.nudgeDue({ ...base, nowMin: 722 }), 'tirzepatide_nudge_720');
  assert.equal(B.nudgeDue({ ...base, nowMin: 722, loggedToday: true }), null); // logged at 11:59
  assert.equal(B.nudgeDue({ ...base, nowMin: 722, sentKinds: ['tirzepatide_nudge_720'] }), null);
  assert.equal(B.nudgeDue({ ...base, nowMin: 800 }), null);
  assert.equal(B.nudgeDue({ ...base, nowMin: 1140 }), 'tirzepatide_nudge_1140');
});

test('peptide: one 15:30 nudge unless logged', () => {
  assert.equal(B.PEPTIDE_NUDGE_MINUTE, 930);
  const p = { nudgeMinutes: [930], nowMin: 930, loggedToday: false, sentKinds: [], kind: 'peptide_nudge' };
  assert.equal(B.nudgeDue(p), 'peptide_nudge');
  assert.equal(B.nudgeDue({ ...p, loggedToday: true }), null);
});

test('21:00 meds push only when the evening briefing already went earlier (or is off)', () => {
  assert.equal(B.medsPushDue({ nowMin: 1260, pending: 1, eveningSent: true, eveningEnabled: true }), true);
  assert.equal(B.medsPushDue({ nowMin: 1260, pending: 1, eveningSent: false, eveningEnabled: true }), false); // briefing comes later and carries it
  assert.equal(B.medsPushDue({ nowMin: 1260, pending: 1, eveningSent: false, eveningEnabled: false }), true);
  assert.equal(B.medsPushDue({ nowMin: 1260, pending: 0, eveningSent: true, eveningEnabled: true }), false);
  assert.equal(B.medsPushDue({ nowMin: 1200, pending: 1, eveningSent: true, eveningEnabled: true }), false);
});

test('glucose alerts: low says IOB and carbs; high names the factor source; never while low or falling', () => {
  const low = B.glucoseAlert('low', { forecastGlucose: 4.1, iob: 1.8, carbsGrams: 15, trendPerMinute: -0.05, currentGlucose: 6.2 });
  assert.deepEqual(low, { title: '⬇️ Low predicted', body: 'Dropping to ~4.1 in 2h — 1.8u still active, have 15g fast carbs ready.' });
  const hi = { forecastGlucose: 14.2, iob: 1.8, suggestedUnits: 1.2, factorSource: 'observed', factorSampleSize: 12, trendPerMinute: 0.03, currentGlucose: 11 };
  assert.equal(B.glucoseAlert('high', hi).body,
    'Heading to ~14.2 in 2h, 1.8u active — consider ~1.20u correction (based on your last 12 corrections).');
  assert.ok(B.glucoseAlert('high', { ...hi, factorSource: 'pump-setting' }).body.includes('(using your set factor)'));
  assert.ok(B.glucoseAlert('high', { ...hi, factorSource: 'learned', factorSampleSize: 18 }).body
    .includes('(based on 18 corrections at this time of day)'));
  assert.equal(B.glucoseAlert('high', { ...hi, trendPerMinute: -0.02 }), null);
  assert.equal(B.glucoseAlert('high', { ...hi, currentGlucose: 3.6 }), null);
  assert.equal(B.glucoseAlert('low', { forecastGlucose: 4.1, iob: 0, trendPerMinute: -0.05, currentGlucose: 6 }).body,
    'Dropping to ~4.1 in 2h — have fast carbs ready.');
});

test('review fix: different equipment in brackets is a different exercise', () => {
  assert.equal(B.sameExercise('Bench Press (Barbell)', 'Bench Press (Dumbbell)'), false);
  assert.equal(B.sameExercise('Bench Press (Barbell)', 'Bench Press'), true);
  const today = { title: 'Push A', volume_kg: 5000, exercises: [{ title: 'Bench Press (Barbell)', sets: 3, top_kg: 80 }] };
  const last = { title: 'Push B', volume_kg: 4000, exercises: [{ title: 'Bench Press (Dumbbell)', sets: 3, top_kg: 30 }] };
  assert.equal(B.workoutLine(today, null, [last]), '🏋️ Push A: 5,000 kg');
});

test('review fix: a briefing is due from 7 min before target until the grace runs out, so a moving target is never skipped', () => {
  assert.equal(B.dueSince(1224, 1215), false); // 20:15 run, target 20:24
  assert.equal(B.dueSince(1214, 1230), true);  // 20:30 run, target moved to 20:14
  assert.equal(B.dueSince(345, 338), true);
  assert.equal(B.dueSince(345, 345 + 121), false); // not hours late
});

test('review fix: dose reminders survive trimming; the workout line goes first', () => {
  const b = B.composeBriefing([
    item('battery_evening_low', 'battery', 50, { reason: 'Body Battery 22%', action: 'Wind down early — screens off 30 min before bed' }, 'evening'),
    item('strain_over', 'strain', 60, { reason: 'strain 14.2, over target on a low-recovery day' }, 'evening'),
  ], { slot: 'evening', headlineOverride: 'In bed by 21:06 (8.4h — catching up on sleep debt).',
    pinned: ['💊 Finasteride, Minoxidil not logged yet.', '💉 Peptide not logged yet today.'],
    extras: ['🏋️ Wk1-4 Upper B (Fri): 7,360 kg, +95 kg on last time; Shoulder Press top set +2.5 kg'] });
  assert.ok(b.body.includes('💊 Finasteride, Minoxidil not logged yet.'), b.body);
  assert.ok(b.body.includes('💉 Peptide not logged yet today.'), b.body);
  assert.ok([...b.body].length <= 180, b.body.length);
});

test('review fix: only an evening app-open counts as a bedtime hint', () => {
  assert.equal(B.fallbackNightPhrase({ snapshot: { battery: 61, takenAt: '2026-10-23T13:05:00Z' } }), null);
  assert.equal(B.fallbackNightPhrase({ snapshot: { battery: 32, takenAt: '2026-10-23T22:40:00Z' } }),
    'No sleep data from last night yet (bed ~23:40 on 32%)');
  assert.equal(B.fallbackNightPhrase({ snapshot: { battery: 61, takenAt: '2026-10-23T13:05:00Z' }, nightGlucose: { low: 5, mean: 6, cv: 10 } }),
    'No sleep data from last night yet — probably a settled night, glucose steady');
});
