# Diabetes Engine Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the diabetes engine's learning with episode-based learning that remembers months of history and learns time-of-day sensitivity / carb ratio, exercise effects, and only-proven modifiers — with the original engine archived out of the build and restorable in one step.

**Architecture:** New pure functions inside `src/diabetes-engine.js` score each finished correction/meal/workout/night against a whole-curve model (all insulin incl. Control-IQ basal deviation, carbs, exercise, trend), and `fitModel` turns stored episodes into a model of 8 three-hour blocks with shrinkage, a ±30% guard band, asymmetric evidence and a 10%/day rate limit. A nightly Edge Function `diabetes-learn` scores new episodes into `dx_episodes` and writes `dx_model`; the app and `notify-glucose-forecast` pass the latest model as `input.model`, and existing engine entry points (`resolveCorrectionFactor`, `suggestMealDose`, `computeForecastCore`, `sensitivityMap`) use it via `applyModel`, falling back to pump settings.

**Tech Stack:** Vanilla JS UMD + `node --test`; Supabase Postgres (RLS, pg_cron), Deno Edge Functions; Capacitor app (`src/app.js`).

**Spec:** `docs/superpowers/specs/2026-10-24-diabetes-learning-design.md` — read it alongside this plan.

## Global Constraints

- Suggestions only — never pump control, never pump-setting changes; wording stays "consider …". No AI/LLM.
- Existing limits stay: `MAX_SUGGESTED_UNITS` 10u, factor bounds `MIN_RELIABLE_FACTOR` 0.5 / `MAX_RELIABLE_FACTOR` 15 mmol/L/u, stacking caution, no high suggestion when glucose < 3.9 or falling, 0.01u rounding.
- Guard band: a learned ISF or carb ratio may differ from the pump profile value for that block by at most **±30%** for dosing; beyond that it is clamped to the band edge and flagged `outsideBand: true` (shown as a review finding).
- Asymmetric evidence: a learned value that means **less insulin** (ISF above pump / carb ratio above pump) is usable at **n ≥ 5** clean episodes in the block; **more insulin** needs **n ≥ 10**; otherwise the block uses the pooled all-day value, then the pump value.
- Rate limit: a block's value moves at most **10% per day** since the previous model.
- Exercise effects only ever **increase** sensitivity / predict lower — never increase a dose.
- Candidate modifiers (site age, illness/RHR-z, short sleep) are active only with **≥ 10 episodes each side** and |effect| > 2 × its standard error.
- Model is "fresh" for **48h** after `fittedAt`; stale or missing → pump settings (original no-history behaviour).
- Time blocks = `REGIMEN_TOD_BUCKETS` (8 × 3h), bucketed by **Europe/London** hour (`hourOfDay`).
- Shared code: edit `src/*.js`; `node scripts/sync-shared.mjs`; `npm test` must pass. Production SQL recorded in `supabase/sql/`. Deploy with `npx -y supabase@2.122.0 functions deploy <name> --project-ref nxawnkpzjixishcerxcv --use-api`. Push `main` only with the owner's OK.
- Lewis's user id `cae63d3e-df60-4415-8a43-64748b6591c3`; Gemma has no diabetes data and must be unaffected.

## Review Focus

1. **Nightscout unreachable or returns partial data during the nightly run** — the previous model stays in force, nothing is deleted, the run reports `skipped`. → test in Task 8.
2. **Control-IQ automatic boluses** arriving as no-carb insulin — counted as insulin activity, never learned from as manual corrections. → test in Task 3 (and adapter in Task 8).
3. **Model missing or stale (first day, Gemma, job failed 3 nights)** — every entry point falls back to pump settings, no throw, wording says "using your set factor". → test in Task 7.
4. **An episode spanning midnight or the clock change** — bucketed by its London start hour; DST day doesn't double- or drop-count. → test in Task 6.
5. **A sparse block whose learned value says more insulin (n = 6)** — not used; the block pools/falls back. → test in Task 6.

---

### Task 1: Archive the original engine + one-step revert

**Files:**
- Create: `archive/diabetes-engine-v1/diabetes-engine.js` (byte-for-byte copy of current `src/diabetes-engine.js`), `archive/diabetes-engine-v1/diabetes-engine.test.js` (copy of `tests/diabetes-engine.test.js` with the require path changed to `./diabetes-engine.js`), `archive/diabetes-engine-v1/README.md` (what it is, how to revert), `scripts/revert-diabetes-engine.mjs`
- Modify: `CLAUDE.md` (new "Diabetes engine revert" section)

**Interfaces:**
- Produces: `node scripts/revert-diabetes-engine.mjs --check` (exit 0 when the archive is present and `node --test archive/diabetes-engine-v1/` passes; changes nothing) and `node scripts/revert-diabetes-engine.mjs` (copies the archived engine over `src/diabetes-engine.js` and its test over `tests/diabetes-engine.test.js`, runs `sync-shared`, then `npm test`; prints the functions to redeploy: `diabetes-sync`, `notify-glucose-forecast`, `diabetes-learn` (unschedule), plus "push main + TestFlight"). Git tag `diabetes-engine-v1` on the commit.
- The archive is never loaded: not in `src/index.html`, `sync-shared.mjs`, the `npm test` glob (`tests/*.test.js`), or any function.

- [ ] **Step 1:** Copy the two files into `archive/diabetes-engine-v1/`, fix the test's require path, write the README.
- [ ] **Step 2:** Write `scripts/revert-diabetes-engine.mjs`. Run `node scripts/revert-diabetes-engine.mjs --check` → Expected: `archive OK (N tests pass)`, exit 0; `git status` shows no change to `src/`.
- [ ] **Step 3:** Add the CLAUDE.md section (revert command + the redeploy list). `npm test` → PASS (archive not included: test count unchanged).
- [ ] **Step 4:** Commit `chore(diabetes): archive engine v1 out of the build with one-step revert`; `git tag diabetes-engine-v1`; push branch + tag.

### Task 2: Simulated patient for learning tests

**Files:**
- Create: `tests/fixtures/sim-patient.js`
- Test: `tests/diabetes-learning.test.js`

**Interfaces:**
- Produces: `simulatePatient(opts) -> { glucoseHistory, boluses, corrections, basalDoses, activities: { workouts }, pumpProfile, truth }`.
  - `opts`: `{ days = 60, seed = 1, startMs, isfByHour: h => number, carbRatioByHour: h => number, scheduledBasalByHour: h => number, exercise: { [type]: { dropPerMin, sensitivityBoost, hours } }, controlIq = true, autoBolus = true, unloggedSnackRate = 0.05, compressionLowRate = 0.02, noiseSd = 0.3, sensorLagMin = 8 }`.
  - Generates 5-min CGM using the engine's own `iobFraction` / `cobFraction` curves (so the model is consistent with the engine), 3 meals/day with boluses, occasional corrections (units, `startGlucose`), Control-IQ temp basal every 5 min deviating from scheduled (and no-carb auto-boluses marked `auto: true` when `autoBolus`), workouts (`{ startTime, endTime, workoutType, avgHr }`), unlogged snacks and compression lows, deterministic PRNG from `seed`.
  - `pumpProfile = { default: [{ time: 'HH:MM', correctionFactor, carbRatio, basalRate }, …] }` — deliberately **wrong** by a known amount (e.g. pump ISF flat at the 24h mean) so learning has something to find.
  - `truth` echoes the functions and lists injected snacks/compression lows with their times.
- [ ] **Step 1: Failing test** `sim patient: 60 days of plausible data` — `glucoseHistory.length` within 5% of `60*288`; all values in 2.2–22.2; ≥ 150 meal boluses; ≥ 30 corrections; `truth.snacks.length > 0`; same seed → identical output.
- [ ] **Step 2:** `node --test tests/diabetes-learning.test.js` → FAIL (module missing). **Step 3:** implement. **Step 4:** PASS. **Step 5:** Commit `test(diabetes): simulated patient fixture`.

### Task 3: Score correction episodes (whole-curve fit)

**Files:**
- Modify: `src/diabetes-engine.js` (new section "STAGE 8 — Learning"), `tests/diabetes-learning.test.js`

**Interfaces:**
- Consumes: `simulatePatient` (Task 2); engine `insulinEffectBetween`, `carbEffectBetween`, `computeTrend`, `hourOfDay`.
- Produces:
  - `basalDeviationUnits(basalDoses, pumpProfile, startMs, endMs) -> number` (delivered temp-basal units minus scheduled units over the window; + = Control-IQ gave more).
  - `episodeContext(input, startMs, opts) -> { hour, weekend, iob, cob, startGlucose, trendPerMin, exercise24h: { minutes, types: string[], trimp }, exercise48h: {…}, siteAgeHours, sensorGapMin, rhrZ, sleepHrs }` (`opts = { pumpProfile, siteChanges, health }`; unknown fields `null`).
  - `scoreCorrectionEpisode(input, correction, { pumpProfile, nowMs, windowMin = 240 }) -> Episode | null` — `null` until `nowMs ≥ start + windowMin`. `Episode = { kind: 'correction', startMs, units, context, fit: { isf, rmse, n }, confounded: null | 'unexplained-rise' | 'compression-low' | 'sensor-gap' | 'too-few-readings' | 'auto-bolus' | 'carbs-in-window' }`.
  - Fit: glucose change Δ(t) over the window is linear in ISF — `Δ(t) ≈ isf · (−I(t) − B(t) + C(t)/CR) + m(t)` where `I` = insulin absorbed from **all** doses (incl. prior IOB and auto-boluses), `B` = basal deviation units absorbed, `C` = carbs absorbed, `CR` = pump carb ratio for the block, `m(t)` = starting trend carried for the first 30 min. Solve least squares for `isf` (closed form), compute RMSE of the residual.
  - Confounder rules: `n < 0.7 × expected readings` or any gap > 20 min → `sensor-gap` / `too-few-readings`; residual rising > 2.0 mmol/L above the fit for ≥ 30 min → `unexplained-rise`; a drop ≥ 2.0 then recovery ≥ 1.5 within 45 min with no insulin/carb explanation → `compression-low`; correction marked `auto` → `auto-bolus`; logged carbs inside the window → `carbs-in-window`.
- [ ] **Step 1: Failing tests:**
  - `correction ISF recovered within 15% of truth at its hour` (sim, clean episodes, mean abs % error ≤ 15).
  - `prior IOB doesn't bias ISF` — episodes with IOB ≥ 1u at start still ≤ 15% error (the v1 single-reading method on the same episodes, via archived `resolveCorrection` logic reproduced inline as `(start − reading@3h)/units`, errs > 25% — assert the new one beats it).
  - `unlogged snack flagged`: episodes overlapping `truth.snacks` → `confounded === 'unexplained-rise'` for ≥ 80% of them.
  - Review Focus 2: `auto-bolus never learned from` — a correction with `auto: true` → `confounded === 'auto-bolus'`.
  - `basalDeviationUnits` — 1h at temp 0 vs scheduled 0.8 → `-0.8`.
- [ ] **Step 2–4:** FAIL → implement → `node scripts/sync-shared.mjs && npm test` PASS.
- [ ] **Step 5:** Commit `feat(diabetes): whole-curve correction episodes`.

### Task 4: Score meal episodes (hindsight dose)

**Files:** Modify `src/diabetes-engine.js`, `tests/diabetes-learning.test.js`

**Interfaces:**
- Consumes: Task 3 helpers; `macroMealLog` entries `{ time, carbs, fat, protein }` (already on `input.macroMealLog`).
- Produces: `scoreMealEpisode(input, bolus, { pumpProfile, isfAt: (ms) => number, nowMs, windowMin = 300 }) -> Episode | null` with `kind: 'meal'`, `carbs`, `units`, `fit: { carbRatio, rmse, n, peakMin, idealUnits }`, `macros: { fat, protein } | null`, `delayedRise: boolean` (peak after 150 min), same `confounded` set (minus `carbs-in-window`; plus `stacked-meal` if another meal within 90 min).
  - Fit with ISF from `isfAt(startMs)`: Δ(t) linear in `1/CR` given ISF → closed form for CR. `idealUnits = carbs / fit.carbRatio` (hindsight dose); also `deltaUnits = idealUnits − units`.
- [ ] **Step 1: Failing tests:** `meal CR recovered within 15% per block` (sim); `under-dosed meal → idealUnits > units` (sim meal dosed at 70% of truth → `idealUnits/units` in 1.3–1.55); `high-fat meal peaks late → delayedRise` (sim meal with fat 40g and delayed absorption → true; plain meal → false).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(diabetes): hindsight meal episodes`.

### Task 5: Score exercise episodes and nights

**Files:** Modify `src/diabetes-engine.js`, `tests/diabetes-learning.test.js`

**Interfaces:**
- Produces:
  - `scoreExerciseEpisode(input, workout, { pumpProfile, isfAt, nowMs }) -> Episode | null` — `kind: 'exercise'`, `workoutType`, `minutes`, `intensity` (`classifyIntensity`), `fit: { dropPerMin, rmse, n }` = unexplained glucose slope (residual after insulin/carbs/basal, fitted ISF) from start to end + 60 min, as mmol/L per exercise minute (positive = drop).
  - `scoreNight(input, nightStartMs, { pumpProfile, isfAt, nowMs }) -> Episode | null` — 00:00–06:00 London; `kind: 'night'`, `fit: { driftPerHr, isfRatio }` where `isfRatio` = best-fit ISF over the night ÷ `isfAt` (sensitivity multiplier); context includes `exercise24h`.
- [ ] **Step 1: Failing tests:** sim with `exercise.run = { dropPerMin: 0.045, sensitivityBoost: 1.2, hours: 24 }` → mean `dropPerMin` for runs within 30% of 0.045; nights after a run → mean `isfRatio` in 1.08–1.35, nights without → 0.9–1.1.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(diabetes): exercise and overnight episodes`.

### Task 6: `fitModel` — blocks, shrinkage, guard band, asymmetry, rate limit, modifiers

**Files:** Modify `src/diabetes-engine.js`, `tests/diabetes-learning.test.js`

**Interfaces:**
- Consumes: Episodes from Tasks 3–5; `prescribedRegimenTable(pumpProfile)` for pump values per block.
- Produces: `fitModel(episodes, pumpProfile, { nowMs, prevModel = null, halfLifeDays = 30, shrinkK = 5 }) -> Model`:
  ```
  Model = { version: 2, fittedAt, blocks: [{ label, from, to,
              isf:       { value, pump, n, source: 'learned'|'pooled'|'pump', outsideBand, se },
              carbRatio: { value, pump, n, source, outsideBand, se } }],      // 8 × REGIMEN_TOD_BUCKETS
            allDay: { isf, carbRatio, nIsf, nCr },
            exercise: { [workoutType]: { dropPerMin, n } , boost: { multiplier, n, hours: 24 } },
            modifiers: { siteAge: { active, effect, n }, illness: {…}, shortSleep: {…} },   // effect = ISF ratio with/without
            meals: { delayedRiseHighFat: { rate, n }, delayedRiseOther: { rate, n } },      // share of meals peaking after 150 min, fat ≥ 20g vs not
            forecastBias: [{ label, from, to, bias, n }] }   // filled from forecastAccuracy by Task 7
  ```
  - Only `confounded === null` episodes count. Weights = 0.5^(age/halfLife). Block value = shrinkage `(n·blockMean + k·allDay)/(n + k)` with `k = shrinkK`.
  - Asymmetry: `lessInsulin = isf > pump` (or `carbRatio > pump`); usable if `n ≥ 5` (less) / `n ≥ 10` (more); else `source: 'pooled'` if allDay is usable by the same rule against the block's pump value, else `'pump'` (value = pump).
  - Band: clamp to `pump × [0.7, 1.3]`, `outsideBand = true` when clamped.
  - Rate limit vs `prevModel` same block: `|value/prev − 1| ≤ 0.10 × daysSince(prev.fittedAt)` (cap applied, not reset).
  - Exercise: per type from exercise episodes (n ≥ 3 to report); `boost.multiplier = max(1, mean night isfRatio after exercise ÷ mean without)` with n ≥ 5 nights each, else `1`.
  - Modifiers: compare correction ISF with/without condition (site age ≥ 48h; `rhrZ ≥ 1.5`; `sleepHrs < 6`): active only if ≥ 10 each side and |Δ| > 2·SE.
- [ ] **Step 1: Failing tests:**
  - `learns time-of-day ISF from the sim` — each block with n ≥ 10 within 20% of `truth.isfByHour(block midpoint)`.
  - `less insulin usable at n=5; more insulin needs n=10` — synthetic episodes: block with 6 episodes showing ISF 30% below pump → `source !== 'learned'`; 6 showing 20% above → `source === 'learned'`. (Review Focus 5.)
  - `guard band clamps and flags` — evidence at 2× pump → value `1.3 × pump`, `outsideBand: true`.
  - `rate limit 10%/day` — prev 3.0 one day ago, evidence 4.0 → value ≤ 3.3.
  - `exercise boost never below 1`.
  - `modifier stays off without evidence` — 4 site-age episodes → `active: false`.
  - Review Focus 4: `episodes bucket by London start hour across the clock change` — an episode starting `2026-10-25T00:30:00Z` (00:30 GMT) lands in `00:00–03:00`; one at `2026-10-24T23:30:00Z` (00:30 BST) also in `00:00–03:00`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(diabetes): fitModel with safety rules`.

### Task 7: Use the model in the engine (replace the old learning)

**Files:** Modify `src/diabetes-engine.js`, `src/briefings.js` (wording), `tests/diabetes-engine.test.js`, `tests/diabetes-learning.test.js`, `tests/briefings.test.js`

**Interfaces:**
- Produces:
  - `applyModel(model, atMs, { workouts = [], nowMs = atMs, siteAgeHours = null, rhrZ = null, sleepHrs = null } = {}) -> { isf, carbRatio, isfSource, crSource, sampleSize, multiplier, exerciseDropPerMin, reasons: string[] } | null` — `null` when model missing or `nowMs − fittedAt > 48h`. `multiplier` = `model.exercise.boost.multiplier` if a workout ended within `boost.hours`, else 1 (and ≥ 1 always); then × each **active** modifier's `effect` whose condition holds now (site age ≥ 48h, rhrZ ≥ 1.5, sleepHrs < 6). ISF used = block ISF × multiplier; carb ratio used = block CR × multiplier; both re-clamped to the ±30% guard band around the pump value. `reasons` e.g. `["sensitivity 2.6 at this time of day (18 corrections)", "+20% after today's Run"]`.
  - `resolveCorrectionFactor(resolvedCorrections, settings, opts = {})` — new `opts.model`, `opts.atMs`: with a fresh model returns `{ factor: applied.isf, source: 'learned', sampleSize, reasons }`; otherwise the pump setting (`source: 'pump-setting'`) — **the rolling-average `'observed'` branch is removed** (that was the old learning). `personalCorrectionFactor` stays exported for the Patterns display only.
  - `computeForecastCore` uses `resolveCorrectionFactor(..., { model: input.model, atMs: now })`, adds `exerciseDropPerMin × remaining-minutes` for an in-progress workout of a learned type, and adds the current block's `forecastBias` (capped ±1.0 mmol/L); return adds `reasons`.
  - `suggestMealDose(input, newCarbs, now)` — with a fresh model: `units = newCarbs / applied.carbRatio`, `source: 'learned'`, `reasons`; without: `fallbackMealDose` (`manual-carb-ratio`). The weighted-imitation ratio is removed.
  - `splitDoseGuide` / `suggestMacroMealDose`: when the model says high-fat meals rise late for Lewis (`meals.delayedRiseHighFat.rate ≥ 0.5`, n ≥ 5), the guide recommends the split/extended dose for fat ≥ 20g with the reason "your high-fat meals usually rise after 2½h (n)"; otherwise current behaviour.
  - `sensitivityMap(input, now)` — returns model blocks (`{ timeOfDay, isf, carbRatio, pumpIsf, pumpCr, n, source, outsideBand }`) when `input.model` present; else the old display cells.
  - `forecastAccuracyByBlock(input, now) -> [{ label, from, to, bias, n }]` (reuses `forecastAccuracy` errors, grouped by London block) — consumed by Task 8 into `model.forecastBias`.
  - App call sites that used `personalCorrectionFactor` for dosing (`src/app.js` ~9604, ~10061) switch to `resolveCorrectionFactor(resolved, settings, { model: input.model, atMs: now })`.
  - `Briefings.glucoseAlert`: `factorSource === 'learned'` → `"(based on <n> corrections at this time of day)"`; `'observed'` kept as an alias with the old wording.
- [ ] **Step 1: Failing tests:**
  - Review Focus 3: `no model / stale model → pump setting` — `resolveCorrectionFactor([], { correctionFactor: 2.5 }, { model: null })` → `{ factor: 2.5, source: 'pump-setting' }`; a model fitted 49h ago → same; `hyperForecast2h` with no model still returns a tier.
  - `fresh model uses the block for the hour` — model with 06–09 ISF 3.0 and 18–21 ISF 2.0 → at 07:00 London factor 3.0, at 19:00 2.0.
  - `exercise only lowers doses` — workout ended 2h ago, boost 1.2 → `suggestMealDose` units ≤ no-workout units; boost recorded as 0.8 in a hand-built model → treated as 1.
  - `forecast bias applied and capped` — block bias −2.5 → forecast shifted by exactly +1.0 (cap) vs bias 0.
  - `meal dose from model` — 60g at a block CR 10 → 6.00u, `source 'learned'`.
  - `glucoseAlert names learned source` — body contains `(based on 18 corrections at this time of day)`.
  - `active modifier applies, inactive doesn't` — model with `siteAge: { active: true, effect: 0.85 }` and `siteAgeHours: 60` → ISF × 0.85 (still within band); `active: false` → unchanged.
  - `learned late-rise suggests a split` — model `delayedRiseHighFat: { rate: 0.7, n: 8 }`, meal fat 30g → guide recommends split with the reason text.
  - Existing `tests/diabetes-engine.test.js` cases that asserted the removed `'observed'` behaviour are updated to the new fallback (note each change in the commit message).
- [ ] **Step 2–4:** FAIL → implement → `node scripts/sync-shared.mjs && npm test` PASS; `node --check src/app.js`.
- [ ] **Step 5:** Commit `feat(diabetes): engine uses the learned model; old learning removed`.

### Task 8: Store episodes + nightly `diabetes-learn`

**Files:**
- Create: `supabase/sql/dx_learning.sql`, `supabase/functions/diabetes-learn/index.ts`
- Modify: `src/nightscout-adapter.js` (auto-bolus + site changes), `supabase/functions/_shared/nightscout-fetch.ts` (`days` option), `src/diabetes-engine.js` (pure `episodesToScore`), tests

**Interfaces:**
- SQL: `public.dx_episodes(user_id uuid references auth.users on delete cascade, kind text check (kind in ('correction','meal','exercise','night')), start_at timestamptz, episode jsonb not null, created_at timestamptz default now(), primary key(user_id, kind, start_at))`; `public.dx_model(user_id uuid references auth.users on delete cascade, fitted_at timestamptz, model jsonb not null, episodes_used int, primary key(user_id, fitted_at))`. RLS on both; select-own policy for authenticated; no client writes. Cron: `select cron.schedule('diabetes-learn', '30 2,3 * * *', $$select private.invoke_edge_fn('diabetes-learn')$$);` — function acts only when London hour is 3.
- Adapter: before writing the classifier, fetch ~200 recent treatments from Lewis's Nightscout (via the existing diabetes-sync path) and record which field marks Control-IQ automatic boluses (tconnectsync); classify those as `bolus` with `auto: true`, `carbs: 0` (insulin activity) instead of `correction`. Add `siteChanges: [{ time }]` from eventType "Site Change". Fixture tests use the recorded shape.
- `fetchNightscoutInput(profile, { days = 14 } = {})`.
- `episodesToScore(input, storedKeys: Set<string>, nowMs, opts) -> Episode[]` — all finished episodes (corrections, meals, workouts, nights) whose key `${kind}|${startMs}` isn't stored, scored with the current pump profile and the latest model's `isfAt`.
- Function: for each `diabetes_enabled` profile with `diabetes_ns_url`: London-hour guard; `days` = 90 if no episodes yet else 3; fetch NS (on failure or < 12h of readings → record `skipped` and continue to next user — **never delete or overwrite the model**); load workouts (Apple Health + Hevy/fitl00p shapes as the app builds them), food macros, health (rhr, sleep) for context; `episodesToScore`; insert `dx_episodes` (`on conflict do nothing`); load last 180 days of episodes; `fitModel(..., { prevModel })`; set `model.forecastBias = forecastAccuracyByBlock(input, now)`; insert `dx_model`; prune `dx_model` rows older than 60 days except the newest.
- [ ] **Step 1: Failing tests:** adapter auto-bolus fixture → `boluses[0].auto === true`, `corrections.length === 0`; site change fixture → `siteChanges.length === 1`; `episodesToScore` skips stored keys and unfinished episodes; Review Focus 1: `episodesToScore` with empty `glucoseHistory` → `[]` (function then reports `skipped`, test the pure guard `shouldLearn(input) === false` when < 144 readings in the last 24h).
- [ ] **Step 2–4:** FAIL → implement → `npm test` PASS; apply SQL via MCP `apply_migration` (`dx_learning`); deploy `diabetes-learn`, `diabetes-sync`, `notify-glucose-forecast`.
- [ ] **Step 5: First run:** invoke `diabetes-learn` manually with a temporary London-hour bypass header `x-force: 1` accepted **only** with the service-role bearer; confirm `dx_episodes` count > 0 per kind and one `dx_model` row; record counts in the ledger. Commit `feat(diabetes): episode store and nightly learning`.

### Task 9: Offline replay gate

**Files:**
- Create: `scripts/replay-diabetes.mjs`, `docs/diabetes-replay-<date>.md` (generated report)
- Modify: `src/diabetes-engine.js` (pure `compareForecasts`), tests

**Interfaces:**
- `compareForecasts(oldEngine, newEngine, input, { fromMs, toMs, stepMin = 15, model }) -> { old: { mae30, mae60, mae120, lateLows }, new: {…}, n }` — at each step, both engines forecast with data up to that moment only (new one with `model` fitted from episodes before that moment); `lateLows` = actual lows (< 3.9) the forecast didn't predict ≥ 30 min ahead.
- Script: `node scripts/replay-diabetes.mjs --days 60` — requires the archived engine (`archive/diabetes-engine-v1/diabetes-engine.js`) as `oldEngine`, fetches Lewis's data through the deployed `diabetes-sync` (NS URL/token read from the profile via service-role env vars set in the shell by the owner, never printed), loads `dx_episodes`, runs `compareForecasts`, writes the report.
- [ ] **Step 1: Failing test:** on a sim patient with strongly time-varying ISF, `compareForecasts(v1, current, …)` → `new.mae60 < old.mae60` and `new.lateLows ≤ old.lateLows`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Gate:** run the script on Lewis's real data. Pass = `new.mae30/60/120 ≤ old` and `new.lateLows ≤ old.lateLows`. Commit the report. **If it fails: stop and report to the owner — do not go live.**

### Task 10: App: load the model + Diabetes tab view

**Files:** Modify `src/app.js`, `src/index.html` (if new containers), `src/app.css`

**Interfaces:**
- App loads the newest `dx_model` row for the user with the diabetes data and sets `input.model` everywhere `input` is built for the engine (Diabetes tab, Simple View, forecasts, `engineAsync` worker inputs).
- Diabetes tab, "What your data says": per 3h block — learned ISF and carb ratio vs pump value, n, source badge (learned / pooled / pump), `outsideBand` shown as "worth discussing with your team"; exercise effects per type and the post-exercise boost; active modifiers; forecast accuracy; "what changed this week" (diff vs the model 7 days earlier).
- [ ] **Step 1:** Implement; **Step 2:** `node --check src/app.js && npm test` → PASS; serve `src/` locally and confirm the tab renders with a sample model (no console errors).
- [ ] **Step 3:** Commit `feat(app): learned model on the Diabetes tab`.

### Task 11: Go live

- [ ] **Step 1:** Confirm Task 9's gate passed and Task 8's first model exists.
- [ ] **Step 2:** Deploy `diabetes-learn`, `diabetes-sync`, `notify-glucose-forecast`, `notify-briefings` (engine copy); schedule the cron (Task 8 SQL).
- [ ] **Step 3:** `node scripts/revert-diabetes-engine.mjs --check` → PASS (revert path still works).
- [ ] **Step 4:** Ask the owner for OK to push `main` + start the TestFlight build. Commit any doc updates.
