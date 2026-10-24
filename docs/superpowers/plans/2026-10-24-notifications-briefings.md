# Morning & Evening Briefings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered pushes with one morning and one evening briefing per person, composed from `insight_rules` parts (no AI), plus capped reminders and a reworded glucose alert.

**Architecture:** A new pure UMD module `src/briefings.js` (composer, schedule maths, workout comparison, sleep fallback, glucose alert wording) is unit-tested in Node and copied to `supabase/functions/_shared/briefings.js` by `scripts/sync-shared.mjs`. A new Edge Function `notify-briefings` (cron every 15 min) decides per person whether a morning/evening briefing is due, builds context with existing shared code, composes, sends, and logs to `briefing_log`. Existing reminder functions are trimmed to the new cadence; the old summary/sleep-target/weigh-in functions are retired.

**Tech Stack:** Vanilla JS UMD modules + `node --test`; Supabase Postgres (RLS, pg_cron), Deno Edge Functions; Capacitor iOS app (`src/app.js`).

**Spec:** `docs/superpowers/specs/2026-10-24-notifications-design.md` — read it alongside this plan.

## Global Constraints

- No live AI / LLM calls anywhere in this work.
- Times are Europe/London; use `londonNow()` / `londonParts()` from `_shared/webpush.ts` on the server.
- Morning briefing defaults: Lewis (`cae63d3e-df60-4415-8a43-64748b6591c3`) **05:45 Mon–Fri, 07:30 Sat–Sun**; Gemma (`2c8bf000-b870-4ea1-8a67-ec00ee7d4041`) **07:30 every day**. Wake times for bedtime maths: Lewis **05:30 weekdays / 07:30 weekends**, Gemma **07:30**.
- Evening briefing = 60 min before suggested bedtime (next wake − `computeSleepNeed(...).needHours`), clamped to **19:00–23:00**.
- One morning and one evening briefing per person per day, never repeated.
- Body ≈ 2 lock-screen lines: **≤ 180 characters** per briefing body (extra lines included); title ≤ 50.
- Briefings contain no dosing instructions. The high-glucose alert keeps its correction suggestion, says "consider", shows IOB, names the factor source ("based on your last N corrections" / "using your set factor"), and never fires during a low or while falling.
- Safety-category phrases (`glucose`, `health`, `diabetes`) are written but **not enabled for briefings until the owner approves them** (Task 4).
- Shared code: edit `src/*.js` only; run `node scripts/sync-shared.mjs`; never hand-edit `supabase/functions/_shared/*.js`. New `src/*.js` modules go in `src/sw.js` `NEVER_CACHE` only if loaded by the app.
- Rules: edit `supabase/seed/insight-rules.json` → `node scripts/build-insight-rules.mjs` → run `supabase/sql/insight_rules_seed.sql`.
- `npm test` must pass after every task. Deploy Edge Functions with `npx -y supabase@2.122.0 functions deploy <name> --project-ref nxawnkpzjixishcerxcv --use-api` (CLI is logged in). Record every production SQL change in `supabase/sql/`.
- Push to `main` only with the owner's explicit OK.

## Review Focus

1. **BST/GMT change day (25 Oct 2026, 29 Mar 2027)** — a 05:45 briefing must still fire once at 05:45 London. → test in Task 2.
2. **No sleep data, no snapshot, no glucose (e.g. Gemma on a day she didn't open the app)** — morning briefing still sends a sensible message from what exists, never "undefined"/"NaN"/"—". → test in Task 3.
3. **Two things due in the same 15-min run** (e.g. Tirzepatide 12:00 nudge and nothing else; or evening briefing at 19:00 and meds) — each sent once, none duplicated across runs. → test in Task 7 (`briefing_log` uniqueness) and Task 9.
4. **Hevy workout with no earlier session of the same routine, or a deload with lower volume** — no "+0 kg"/negative bragging; line says the session, no comparison. → test in Task 5.
5. **Tirzepatide logged at 11:59 / peptide logged mid-afternoon** — the next scheduled nudge does not go out. → test in Task 9.

---

### Task 1: Rule parts columns + validation

**Files:**
- Modify: `src/insights.js` (`validateRule`, `evaluateInsights` output)
- Modify: `scripts/build-insight-rules.mjs` (insert/upsert new columns)
- Create: `supabase/sql/insight_rules_parts.sql`
- Test: `tests/insights.test.js`

**Interfaces:**
- Produces: rule fields `headline?: string`, `reason?: string`, `action?: string`, `slot?: 'app'|'morning'|'evening'|'both'` (default `'app'`). `evaluateInsights` items gain `headline`, `reason`, `action`, `slot` (each template-filled, or `null`).

- [ ] **Step 1: Write failing tests** in `tests/insights.test.js`:
  - `validateRule` returns `[]` for `{...valid, headline:'Recovery {recovery}', reason:'after only {sleep_hrs:1}h sleep', action:'Take it easy', slot:'morning'}`.
  - returns an error containing `bad slot` for `slot:'noon'`; containing `unknown template key nope` for `reason:'{nope}'`.
  - `evaluateInsights([rule], {recovery:31, sleep_hrs:4.9})[0]` has `headline === 'Recovery 31'`, `reason === 'after only 4.9h sleep'`, `slot === 'morning'`; a rule without parts yields `headline === null`, `slot === 'app'`.
- [ ] **Step 2:** `npm test` → the new tests FAIL.
- [ ] **Step 3:** Implement in `src/insights.js`; template keys in `headline/reason/action` validated against `METRICS` like title/body. Build script adds `headline, reason, action, slot` to the insert and the `on conflict` update list.
- [ ] **Step 4:** Create `supabase/sql/insight_rules_parts.sql`: `alter table public.insight_rules add column if not exists headline text, add column if not exists reason text, add column if not exists action text, add column if not exists slot text not null default 'app' check (slot in ('app','morning','evening','both'));` — apply with the Supabase MCP `apply_migration` (name `insight_rules_parts`).
- [ ] **Step 5:** `node scripts/sync-shared.mjs && node scripts/build-insight-rules.mjs && npm test` → PASS.
- [ ] **Step 6:** Commit `feat(insights): headline/reason/action/slot rule parts`.

### Task 2: `src/briefings.js` — schedule maths

**Files:**
- Create: `src/briefings.js` (UMD, global `Briefings`, same export pattern as `src/insights.js`)
- Modify: `scripts/sync-shared.mjs` (add `{ name: 'briefings', global: 'Briefings' }`)
- Test: `tests/briefings.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_SCHEDULES: { [userId]: { morning: { weekday: 'HH:MM', weekend: 'HH:MM' }, wake: { weekday: 'HH:MM', weekend: 'HH:MM' } } }` with the Global Constraints values; `defaultSchedule()` = Gemma's shape (07:30 everywhere) for any other user.
  - `scheduleFor(userId, saved?) -> {morning, wake}` (saved = `profiles.briefing_schedule` jsonb, merged over the default).
  - `isWeekend(weekday: 'Mon'..'Sun') -> boolean` (Sat, Sun).
  - `morningTime(schedule, weekday) -> minutesSinceMidnight`.
  - `eveningTime({ needHours, schedule, tomorrowWeekday }) -> minutesSinceMidnight` = wake(tomorrow) − needHours×60 − 60, clamped to [1140, 1380].
  - `isDue(targetMin, nowMin, toleranceMin = 7) -> boolean` (|now − target| ≤ tolerance; cron is every 15 min).
- [ ] **Step 1: Failing tests:**
  - `morningTime(scheduleFor(LEWIS), 'Tue') === 345`; `'Sat' === 450`; Gemma `'Tue' === 450`.
  - `eveningTime({needHours: 8.4, schedule: scheduleFor(LEWIS), tomorrowWeekday: 'Wed'}) === 1206` (wake 05:30 − 8h24m = bed 21:06; − 60 min = 20:06).
  - `eveningTime({needHours: 8, schedule: scheduleFor(LEWIS), tomorrowWeekday: 'Sat'}) === 1350` (wake 07:30 − 8h = bed 23:30; − 60 = 22:30).
  - clamp: `eveningTime({needHours: 12, schedule: scheduleFor(LEWIS), tomorrowWeekday: 'Wed'}) === 1140`.
  - `isDue(345, 352) === true`, `isDue(345, 353) === false`.
  - BST change (Review Focus 1): build London parts with `new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...})` for `2026-10-26T05:45:00Z` (GMT, Monday) and `2026-10-23T04:45:00Z` (BST, Friday) → both give `hour 5, minute 45`, and `isDue(morningTime(..), 345)` is true for each.
- [ ] **Step 2:** `npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement the functions above in `src/briefings.js`.
- [ ] **Step 4:** `node scripts/sync-shared.mjs && npm test` → PASS (sync check included).
- [ ] **Step 5:** Commit `feat(briefings): schedule maths`.

### Task 3: Composer + sleep fallback

**Files:**
- Modify: `src/briefings.js`
- Test: `tests/briefings.test.js`

**Interfaces:**
- Consumes: `evaluateInsights` items from Task 1 (with `headline/reason/action/slot/category/severity/priority`).
- Produces:
  - `composeBriefing(items, { slot, extras = [], maxChars = 180, headlineOverride = null }) -> { title: string, body: string, ruleIds: string[] }`. `headlineOverride` (used by the evening bedtime line) replaces the rule headline. Uses only items whose `slot` is `slot` or `'both'`. Headline: first item with a headline (else `'Good morning'`/`'Tonight'`). Reasons: next ≤2 items (distinct categories) with a `reason`, joined `"<r1>, and <r2>"`. Action: first item with an action, where items in categories `glucose|health|diabetes` outrank others. Body = `"<headline> <reasons>. <Action>."` + each extra on its own line; drop the second reason, then trailing extras, until `body.length <= maxChars`. Title: `'⚡ Morning'` / `'🌙 Evening'` + `' · ' + headline` if it fits in 50.
  - `fallbackNightPhrase({ snapshot?: {battery, takenAt}, nightGlucose?: {low, mean, cv} }) -> string|null` — `null` if nothing known; otherwise `"No sleep data from last night yet — probably a <settled|broken> night"` + `" (bed ~HH:MM on N%)"` if snapshot + `", glucose steady"`/`", glucose dipped to X"` as known. "broken" when `nightGlucose.low < 3.9` or `nightGlucose.cv > 36`.
- [ ] **Step 1: Failing tests** (fixture items built with the spec examples):
  - rough morning → body starts `"Recovery 31 after only 4.9h sleep, and HRV's been down all week. Take it easy — light walk today."`
  - good morning with extra `'⚖️ Weigh-in day.'` → body `"You've recovered well (78). Push hard today.\n⚖️ Weigh-in day."`
  - an item with `slot:'app'` is ignored; `category:'glucose'` action beats a recovery action.
  - a 300-char combination returns `body.length <= 180`.
  - Review Focus 2: `composeBriefing([], {slot:'morning'})` → body is a non-empty sentence with no `undefined|NaN|—` (assert regex `/undefined|NaN|—/` does not match); `fallbackNightPhrase({})` → `null`; `fallbackNightPhrase({snapshot:{battery:32,takenAt:'2026-10-23T22:40:00Z'}, nightGlucose:{low:5.1,mean:6.8,cv:18}})` → `"No sleep data from last night yet — probably a settled night (bed ~23:40 on 32%), glucose steady"`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement both functions (London clock for `HH:MM` via `Intl.DateTimeFormat`).
- [ ] **Step 4:** `node scripts/sync-shared.mjs && npm test` → PASS.
- [ ] **Step 5:** Commit `feat(briefings): composer and sleep fallback phrase`.

### Task 4: Phrases in the rules (non-safety live; safety held for review)

**Files:**
- Modify: `supabase/seed/insight-rules.json`, regenerated `supabase/sql/insight_rules_seed.sql`
- Test: `tests/insights.test.js`

**Interfaces:**
- Consumes: Task 1 fields.
- Produces: phrases on rules. Morning (`slot:'morning'` or `'both'`): all `recovery_*`, `sleep_*`, `trend_*`, `strain_yesterday_big`, `training_*`, `battery_woke_low`, `battery_poor_charge`, `battery_full_morning`, `weight_*`, `nutrition_weekly_*`. Evening (`'evening'`/`'both'`): `strain_over_target_low_recovery`, `strain_room_left`, `battery_*` evening rules, `nutrition_under_evening`, `nutrition_over_today`, `activity_steps_*`, `sleep_debt_high`, `trend_short_nights`. Required examples (exact): `recovery_red` headline `Recovery {recovery}`, action `Take it easy — light walk today`; `recovery_green` headline `You've recovered well ({recovery})`, action `Push hard today`; `sleep_very_short` reason `after only {sleep_hrs:1}h sleep`; `trend_hrv_down` reason `HRV's been down all week`.
- [ ] **Step 1: Failing test:** every rule with `slot` in morning/evening/both has at least one of headline/reason/action; the four exact phrases above are present; every rule in categories `glucose|health|diabetes` has `slot === 'app'` (held for review).
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Write phrases for all listed rules in the JSON (reasons are clauses that read after a headline; actions are imperatives without a full stop). Also write phrases for the safety-category rules but leave their `slot` as `'app'`.
- [ ] **Step 4:** `node scripts/build-insight-rules.mjs && npm test` → PASS; run `supabase/sql/insight_rules_seed.sql` via MCP `execute_sql`.
- [ ] **Step 5:** Commit `feat(rules): briefing phrases (safety phrases held for owner review)`.
- [ ] **Step 6: OWNER CHECKPOINT.** Send the owner the list of safety-category phrases (rule id → headline / reason / action). Only after their written OK: set those rules' `slot` to the agreed value, rebuild, rerun the seed SQL, commit `feat(rules): enable approved safety phrases in briefings`. Until then the briefings ship without them.

### Task 5: Hevy top sets + workout comparison

**Files:**
- Modify: `supabase/functions/hevy-sync/index.ts` (`summarise`: exercise entries become `{ title, sets, top_kg }`, `top_kg` = max `weight_kg` among working sets, `null` if none)
- Modify: `src/briefings.js`
- Test: `tests/briefings.test.js`

**Interfaces:**
- Produces: `workoutLine(today: HevyRow, previousSameRoutine: HevyRow|null) -> string|null` where `HevyRow = { title, routine_id, volume_kg, exercises: [{title, sets, top_kg}] }`. Format: `"🏋️ <title>: <volume> kg"` + `", +<Δ> kg on last time"` only when Δ > 0 + `"; <exercise> top set +<x> kg"` for the single largest top-set increase > 0 (names shortened by dropping a trailing ` (…)`). `null` when `today` is null.
- [ ] **Step 1: Failing tests:** Upper B 7360 vs 7265 with shoulder press top 60 vs 57.5 → `"🏋️ Wk1-4 Upper B (Fri): 7,360 kg, +95 kg on last time; Shoulder Press top set +2.5 kg"`; Review Focus 4: no previous → `"🏋️ Wk1-4 Upper B (Fri): 7,360 kg"`; lower volume and no top-set gains → same no-comparison form (no `+0`, no negatives).
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement `workoutLine`; update `summarise` in hevy-sync. **Step 4:** `node scripts/sync-shared.mjs && npm test` → PASS; deploy `hevy-sync`; after its next run, `select exercises from hevy_workouts order by synced_at desc limit 1` shows `top_kg` (only for workouts synced after the deploy).
- [ ] **Step 5:** Commit `feat(hevy): store top set per exercise; workout comparison line`.

### Task 6: Evening snapshot (app)

**Files:**
- Create: `supabase/sql/readiness_snapshots.sql`
- Modify: `src/app.js` (in `loadBodyBattery`, after `bbState` is set)

**Interfaces:**
- Produces: table `public.readiness_snapshots(user_id uuid default auth.uid() references auth.users on delete cascade, snap_date date, taken_at timestamptz not null default now(), battery smallint, strain numeric, battery_parts jsonb, primary key(user_id, snap_date))`, RLS policy own rows for authenticated, `grant select, insert, update`. App upserts `{ snap_date: todayISO(), taken_at: now, battery: round(bbLevelNow()), strain: insightInputs?.strain?.score ?? null, battery_parts: bbState.result.parts }` on every Body Battery recompute (latest wins), `onConflict: 'user_id,snap_date'`, errors logged with `console.warn` only.
- [ ] **Step 1:** Write the SQL; apply via MCP `apply_migration` (`readiness_snapshots`).
- [ ] **Step 2:** Add the upsert to `loadBodyBattery`.
- [ ] **Step 3:** `node --check src/app.js && npm test` → PASS.
- [ ] **Step 4:** Commit `feat(app): save daily readiness snapshot for briefings`.

### Task 7: `notify-briefings` — morning

**Files:**
- Create: `supabase/functions/notify-briefings/index.ts`
- Create: `supabase/sql/briefings.sql` (table `briefing_log`, `profiles.briefing_schedule`, cron)
- Test: `tests/briefings.test.js` (pure context helper)

**Interfaces:**
- Consumes: `Briefings.scheduleFor/morningTime/isDue/composeBriefing/fallbackNightPhrase` (Tasks 2–3), `Insights.evaluateInsights/healthTrendMetrics/dailyContextMetrics/glucoseMetrics`, `_shared/health-scores.ts` (`computeRecoveryScore`, `computeSleepScore`, `computeStrainScoreTrimp`, `computeSleepNeed`), `_shared/webpush.ts` (`sendToSubscriptions`, `sbFetch`, `londonNow`).
- Produces:
  - SQL: `public.briefing_log(user_id uuid, kind text check (kind ~ '^(morning|evening|meds|peptide_nudge|tirzepatide_nudge_[0-9]+)$'), sent_date date, sent_at timestamptz default now(), body text, primary key(user_id, kind, sent_date))`, RLS enabled, no client policies (service role only). `alter table profiles add column if not exists briefing_schedule jsonb; grant update (briefing_schedule) on profiles to authenticated;` Cron: `select cron.schedule('notify-briefings', '*/15 * * * *', $$select private.invoke_edge_fn('notify-briefings')$$);`
  - `Briefings.morningExtras({ weekday, isLewis, weighinDue, tirzepatideDue, peptideDue }) -> string[]` (pure; e.g. `'⚖️ Weigh-in day.'`, `'💉 Tirzepatide due today.'`, `'💉 Peptide dose today.'`); weigh-in due = Gemma daily, Lewis on Tuesdays unless already logged.
  - Function behaviour: every run, for each user with push subscriptions and `notification_prefs` `morning_briefing` not disabled, if `isDue(morningTime(...), nowMin)` and no `briefing_log (user, 'morning', today)` row: build the same context as `notify-daily-summary` (copy its `buildSummary` context code), add glucose metrics from Nightscout via `_shared/nightscout-fetch.ts` when the profile has `diabetes_ns_url`, use `fallbackNightPhrase` when today's `health_daily.sleep_total_hrs` is null (snapshot = yesterday's `readiness_snapshots` row), compose with `slot:'morning'`, send, insert the `briefing_log` row (insert first with `on conflict do nothing`; only send if the insert returned a row — prevents double sends across overlapping runs).
- [ ] **Step 1: Failing test:** `morningExtras({weekday:'Tue', isLewis:true, weighinDue:true, tirzepatideDue:false, peptideDue:false})` → `['⚖️ Weigh-in day.']`; Gemma any day with weigh-in due → same; nothing due → `[]`.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement `morningExtras`; write the SQL and apply via MCP; write the function. **Step 4:** `node scripts/sync-shared.mjs && npm test` → PASS; deploy `notify-briefings`.
- [ ] **Step 5: Verify (dry run):** temporarily call with header-less `private.invoke_edge_fn('notify-briefings')` outside both users' times → response `{"morning":{"sent":0,...},"evening":{...}}` with status 200; then set Lewis's `briefing_schedule` morning weekday/weekend to the current London time + 15 min, wait for the run, confirm one push arrives and one `briefing_log` row exists; the next run sends nothing; restore the schedule.
- [ ] **Step 6:** Commit `feat(briefings): morning briefing function`.

### Task 8: `notify-briefings` — evening

**Files:**
- Modify: `supabase/functions/notify-briefings/index.ts`, `src/briefings.js`
- Test: `tests/briefings.test.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7.
- Produces: `Briefings.bedtimeLine({ needHours, wakeMin, strainHours, debtHours }) -> string` e.g. `"In bed by 21:06 (8.4h — catching up on sleep debt)."` (reason: debt > 0.5 → "catching up on sleep debt"; else strain > 0.5 → "after today's strain"; else none). Evening run: if `isDue(eveningTime(...), nowMin)` and no evening log row → context = today's health + snapshot (battery, strain) + glucose day metrics + today's Hevy workout and the previous `hevy_workouts` row with the same `routine_id`; body = `composeBriefing(items, { slot:'evening', headlineOverride: bedtimeLine(...), extras: [workoutLine(...), pending meds line, peptide last-call line].filter(Boolean) })` so the 180-char rule applies to everything.
- [ ] **Step 1: Failing tests:** `bedtimeLine({needHours:8.4, wakeMin:330, strainHours:0.1, debtHours:1.2})` → `"In bed by 21:06 (8.4h — catching up on sleep debt)."`; `composeBriefing(items, {slot:'evening', headlineOverride:'In bed by 21:06.'}).body` starts with `"In bed by 21:06."`; body without snapshot has no Body Battery mention (no `%` from battery) — use an items fixture whose battery rule needs `battery`.
- [ ] **Step 2–4:** FAIL → implement `bedtimeLine` and the evening branch → `npm test` PASS; deploy.
- [ ] **Step 5: Verify** like Task 7 Step 5 with `wake` times shifted so evening time lands 15 min ahead.
- [ ] **Step 6:** Commit `feat(briefings): evening briefing`.

### Task 9: Reminder cadence

**Files:**
- Modify: `supabase/functions/notify-tirzepatide/index.ts`, `supabase/functions/notify-peptide/index.ts`, `supabase/functions/notify-oral-meds/index.ts`, `src/briefings.js`
- Create: `supabase/sql/reminder_crons.sql`
- Test: `tests/briefings.test.js`

**Interfaces:**
- Produces:
  - `Briefings.TIRZEPATIDE_NUDGE_MINUTES = [720, 900, 1020, 1140]` (12:00, 15:00, 17:00, 19:00); `Briefings.PEPTIDE_NUDGE_MINUTE = 930` (15:30).
  - `Briefings.nudgeDue({ nudgeMinutes: number[], nowMin, loggedToday: boolean, sentKinds: string[], kind }) -> string|null` — returns the `briefing_log.kind` to record (e.g. `'tirzepatide_nudge_720'`; peptide uses `'peptide_nudge'`) when not logged, `isDue` matches one of the minutes and that kind isn't in `sentKinds`; otherwise `null`.
  - Oral meds: send at 21:00 only if not logged **and** today's evening briefing was due before 21:00 (`eveningTime < 1260`) — otherwise the evening briefing already carried it.
- [ ] **Step 1: Failing tests (Review Focus 5):** `nudgeDue({nudgeMinutes:[720,900,1020,1140], nowMin:722, loggedToday:false, sentKinds:[], kind:'tirzepatide_nudge'})` → `'tirzepatide_nudge_720'`; same with `loggedToday:true` → `null`; with `sentKinds:['tirzepatide_nudge_720']` → `null`; `nowMin:800` → `null`; peptide `nudgeDue({nudgeMinutes:[930], nowMin:930, loggedToday:false, sentKinds:[], kind:'peptide_nudge'})` → `'peptide_nudge'`.
- [ ] **Step 2–4:** FAIL → implement helpers; rewrite Tirzepatide (only on due day; drop the hourly loop), peptide (single 15:30 nudge; the morning line and evening last call come from Tasks 7–8), oral meds (rule above); each records its `briefing_log` row with insert-before-send like Task 7. In `supabase/sql/reminder_crons.sql` set crons: `notify-tirzepatide` → `*/15 11-19 * * *`, `notify-peptide` → `*/15 15 * * *`. `npm test` PASS; deploy the three functions.
- [ ] **Step 5:** Commit `feat(reminders): capped Tirzepatide/peptide nudges, meds only when not covered`.

### Task 10: Glucose alert wording

**Files:**
- Modify: `src/diabetes-engine.js` (`computeForecastCore` success return adds `factorSource: factorResult.source`, `iob: ctx.iob`, `trendPerMinute: ctx.trendPerMinute`; `stripCtx` keeps them)
- Modify: `src/briefings.js`, `supabase/functions/notify-glucose-forecast/index.ts` (`buildLowMessage`/`buildHighMessage` delegate to `Briefings.glucoseAlert`)
- Test: `tests/briefings.test.js`, `tests/diabetes-engine.test.js`

**Interfaces:**
- Produces: `Briefings.glucoseAlert(kind: 'low'|'high', f: { forecastGlucose, minutesAhead?, iob, factorSource, factorSampleSize, suggestedUnits?, trendPerMinute, currentGlucose, carbsGrams? }) -> { title, body } | null`.
  - low: `{ title:'⬇️ Low predicted', body:"Dropping to ~4.1 in 2h — <iob>u still active, have <carbs>g fast carbs ready." }` (carbs from `preventativeCarbAdvice`, falls back to "fast carbs").
  - high: body `"Heading to ~14.2 in 2h, <iob>u active — consider ~1.20u correction (based on your last <n> corrections)."` / `"(using your set factor)"`; returns `null` when `currentGlucose < 3.9` or `trendPerMinute < 0` (never during a low or while falling).
- [ ] **Step 1: Failing tests:** the two bodies above with `iob:1.8`, `carbsGrams:15`, `suggestedUnits:1.2`, `factorSource:'observed'`, `factorSampleSize:12`; `factorSource:'pump-setting'` → contains `"using your set factor"`; `trendPerMinute:-0.02` → `null`; engine test: `hyperForecast2h(fixture)` result has `factorSource` and `iob` keys.
- [ ] **Step 2–4:** FAIL → implement → `node scripts/sync-shared.mjs && npm test` PASS → deploy `notify-glucose-forecast` (CLI) and `diabetes-sync` (engine copy changed).
- [ ] **Step 5:** Commit `feat(glucose): reworded forecast alerts with learned-factor source`.

### Task 11: Settings + retire old notifications

**Files:**
- Modify: `src/app.js` (notification settings list at ~line 8010), `src/index.html` if the settings markup needs time inputs
- Create: `supabase/sql/retire_old_notifications.sql`

**Interfaces:**
- Consumes: `profiles.briefing_schedule` (Task 7), `Briefings.scheduleFor` defaults (Task 2 values).
- Produces: settings entries `morning_briefing` ("Morning briefing" — weekday + weekend time inputs, writes `briefing_schedule.morning`) and `evening_briefing` ("Evening briefing" — on/off; weekday + weekend **wake** time inputs, writes `briefing_schedule.wake`); remove `daily_summary`, `sleep_target`, `weighin` entries. SQL: `select cron.unschedule(j) from unnest(array['notify-daily-summary','notify-sleep-target','notify-weighin','notify-weighin-gemma']) j;` then delete those four functions with `npx -y supabase@2.122.0 functions delete <name> --project-ref nxawnkpzjixishcerxcv`, and `git rm -r` their folders.
- [ ] **Step 1:** Implement the settings entries (times stored as `'HH:MM'`; empty input keeps the default).
- [ ] **Step 2:** `node --check src/app.js && npm test` → PASS.
- [ ] **Step 3:** Only after Task 7 and 8 have each delivered a real briefing: run the retire SQL, delete the four functions, `git rm` their folders, run `npm test`.
- [ ] **Step 4:** Commit `feat(settings): briefing times; retire old summary/sleep/weigh-in pushes`.
- [ ] **Step 5:** Ask the owner for OK to push to `main` (TestFlight build for the snapshot + settings app changes).
