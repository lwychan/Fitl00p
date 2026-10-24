# Diabetes engine learning — design

Date: 2026-10-24 · Status: draft for owner review · Owner: Lewis (type 1, Tandem t:slim X2 with Control-IQ, Dexcom via Nightscout)

The owner asked for this design directly ("skip straight to writing the design"). Everything below not attributed to the owner is **Claude's call**, marked as such, for the owner to confirm or change while reading.

## Intent

fitl00p should learn **how Lewis's body actually responds** to insulin, carbs and exercise — at different times of day and in different situations — and use that evidence for its correction suggestions, meal-dose suggestions and glucose forecasts. Owner's words (notifications brainstorm): *"I want the app to learn how my body reacts to insulin and carbs and use the historical evidence to shape future suggestions."* This request adds: understand *all* the information — exercise, carbs on board (COB), insulin on board (IOB), time of day, time-of-day insulin sensitivity, and anything else that makes sense.

## What exists today (why it needs redoing)

All learning lives in `src/diabetes-engine.js` (pure UMD, ~176 KB, shared to the server). It re-learns from scratch on every call, from whatever the app or a function fetched — **14 days** of Nightscout data. Findings from the earlier review (`plans/README.md`):

1. **Nothing is remembered.** No episode or learned value is stored; history beyond 14 days is never used.
2. **Correction factor is crude.** `resolveCorrection` takes one reading ~3h after a correction: `(start − reading) / units`. It ignores insulin already on board from earlier doses, Control-IQ's automatic basal changes and boluses (which on a t:slim are constant), exercise, and the trend at the time. Then `personalCorrectionFactor` averages the last 10 "clean" ones.
3. **One factor for the whole day.** `sensitivityMap` already splits corrections by time of day and post-exercise vs rest, but it is display-only; dosing uses the single all-day factor.
4. **Meal doses imitate the past.** `suggestMealDose` averages the grams-per-unit Lewis *actually dosed* (weighted by similarity), nudged ±15% by a crude outcome flag. If past doses were wrong, it copies the mistake.
5. **"Ran high" is too crude.** Any reading above 8.5 in 3h counts as "ran high", regardless of how high, for how long, or why.
6. **Forecast bias is measured but never applied.** `forecastAccuracy` computes a signed error; the forecast doesn't use it.
7. **Learning is untested.** Tests cover dose arithmetic, not whether learning finds the truth.

## Goals

1. **Remember every episode, once.** Each correction, meal, exercise session and night is scored once, with its full context, and stored. Learning uses months of history, not 14 days.
2. **Measure each episode properly.** Explain the whole glucose curve after a dose — not one reading — using everything that moved it: this dose, insulin already on board, carbs on board, Control-IQ's basal deviation from the programmed rate, exercise and trend. Then solve for the person's sensitivity from that.
3. **Insulin sensitivity and carb ratio by time of day.** Learn a daily curve (finer than "one number"), borrowing strength from the all-day value where a time block has little data, so sparse blocks don't swing wildly.
4. **Exercise as a learned effect.** Learn, per workout type and intensity, both:
   - the immediate glucose drop during and after the session;
   - the longer-lasting rise in sensitivity (typically up to 24–48h, and often overnight).

   Both are applied to forecasts and suggestions when there's been recent exercise.
5. **Learn meal doses from hindsight.** For each past meal, work out the dose that *would have* kept glucose in range (actual dose adjusted by the unexplained excess or shortfall ÷ sensitivity). Learn the carb ratio from those "ideal" doses, not from what was dosed. Use fitl00p's food log macros (fat/protein) to learn which meals rise late, and need a split or extended dose.
6. **Use other evidence only where it earns its place.** Candidates:
   - infusion site age (Nightscout "Site Change"; day 3 sites are often weaker);
   - illness or poor recovery (resting-HR z-score, which fitl00p already computes);
   - short sleep;
   - dawn phenomenon (covered by time of day);
   - cumulative 24h exercise load.

   Each candidate is a *modifier* that is only switched on when the stored episodes show a real, consistent effect for Lewis. Otherwise it's ignored.
7. **Correct the forecast with its own track record.** Apply the measured forecast bias, by time of day and capped, and keep grading it.
8. **Say what it used.** Every suggestion names the learned values behind it and how much evidence they rest on, e.g. "sensitivity 2.6 at this time of day (from 18 corrections), +20% after this morning's run". This extends the existing "based on your last N corrections" alert wording.
9. **Prove it works before it goes live, and keep a way back.** Owner's decision: the new engine *replaces* the original in the build (no live side-by-side run). The original is archived intact, out of the build, ready to restore in one step (see Rollout). Before the switch it must pass the simulated-patient tests *and* an offline replay against Lewis's own stored history (Claude's call, below).
10. **Tested learning.** A simulated patient with known, hidden values (sensitivity by time of day, carb ratio, exercise effect, noise, Control-IQ-like basal changes) generates synthetic data. The learning must recover those values within tolerance. This is the core test suite, alongside regression tests of the safety rules.

## Non-goals

- No automatic dosing, pump control or pump-setting changes. fitl00p suggests; Lewis and Control-IQ decide. Suggestions stay "consider …".
- Not replacing Control-IQ or its algorithm.
- No AI/LLM, consistent with the briefings project.
- No new data collection on the phone beyond what's already synced. Nightscout, Apple Health, Hevy and the food log already hold everything.
- Not a medical device. The existing "may help / worth a conversation with your team" framing stays.
- Gemma (no diabetes tracking) is unaffected.

## Anti-goals (a failure even if it "works")

- **More aggressive suggestions on thin evidence.** A learned value that *increases* a suggested dose must need more evidence than one that decreases it (asymmetric caution, see Safety).
- **Learning from confounded episodes.** Examples:
  - a "correction" that was really eaten carbs that weren't logged (a rise the model can't explain);
  - a compression low;
  - sensor warm-up or gaps;
  - a pump suspension or occlusion.

  Each is flagged and excluded, never averaged in.
- Silent big jumps: a learned value moving a lot overnight without it being visible.
- Hiding uncertainty: a confident-looking number from 2 episodes.
- Breaking what works today: forecasts, alerts and charts must keep working throughout. The new engine goes live only after the offline replay, and the original can be restored in one step.
- Any suggestion during a low or while falling (already enforced, must stay).

## Safety constraints (Claude's calls — owner to confirm)

- **Existing hard limits stay:**
  - `MAX_SUGGESTED_UNITS` (10u);
  - factor bounds 0.5–15 mmol/L per unit;
  - stacking caution;
  - no high-alert suggestion when below 3.9 or falling;
  - 0.01u rounding.
- **Guard band around the pump settings:** a learned sensitivity or carb ratio may differ from the value programmed in the pump profile for that time by **at most ±30%** (my call). A bigger difference is shown as a regimen-review finding ("your evidence suggests …, worth discussing") rather than used for dosing.
- **Asymmetric evidence:**
  - a learned change that makes doses *smaller* (higher sensitivity / higher carb ratio) can be used at **≥5** clean episodes in that time block;
  - a change that makes doses *larger* needs **≥10**;
  - below that, the block borrows from the all-day value, then from the pump setting.

  These thresholds are my call.
- **Rate limit:** a time block's learned value can move at most **10% per day** (my call). A sudden real change (new insulin, illness) shows up over days, visibly, not overnight.
- **Exercise modifiers only ever increase sensitivity** (reduce doses / predict lower). They never make a suggestion bigger.

## How it fits together

### New pieces

- **In `src/diabetes-engine.js` itself (owner's decision: overwrite the existing module).** The new learning *replaces* the old learning code in place — `resolveCorrection`'s single-reading read, `personalCorrectionFactor`, the imitation-based ratio in `suggestMealDose`, and the display-only `sensitivityMap` — rather than living in a separate module. Pure functions:
  - `scoreCorrectionEpisode(...)`, `scoreMealEpisode(...)`, `scoreExerciseEpisode(...)`, `scoreNight(...)`: take a window of readings, doses, basal and activity, and return a scored episode. Each includes the context it happened in and its confounder flags.
  - `fitModel(episodes, pumpProfile, now)`: returns the learned model:
    - sensitivity and carb ratio per time block, each with an evidence count and confidence;
    - exercise effects per type and intensity;
    - active modifiers;
    - forecast bias by time of day.
  - `applyModel(model, situation)`: the sensitivity, carb ratio and expected exercise effect to use *right now*, with the reasons, for the existing engine functions to consume.
- **Tables:**
  - `dx_episodes`: one row per user per episode, written once, with episode kind, start time, context and outcome.
  - `dx_model`: one row per user per fitted model version, keeping history so changes are visible and reversible.
  - RLS own-rows for the app to read; writes are service role only.
- **`diabetes-learn` Edge Function**, scheduled nightly (e.g. 03:30 London):
  1. pulls Nightscout since the last run (the first run backfills as far as Nightscout and Apple Health go, ideally ~90 days);
  2. scores episodes that have now finished;
  3. writes them;
  4. refits the model;
  5. stores the model.

  It reuses `_shared/nightscout-fetch.ts`.

### Existing pieces that change

- `resolveCorrectionFactor` / `computeForecastCore` / `suggestCorrectionDose` / `suggestMealDose` / `preventativeCarbAdvice` / `projectedGlucoseCurve` read the learned model (via `applyModel`) when one is available and active. Otherwise they behave exactly as today.
- `notify-glucose-forecast` loads the user's latest model.
- The Diabetes tab shows the learned curves:
  - sensitivity and carb ratio by time of day against the pump settings;
  - exercise effects;
  - forecast accuracy;
  - live accuracy since the switch, plus a "what changed this week" list.

  Layout is left to the builder, following the existing Diabetes tab style.

### Measuring an episode (the core idea)

For a window after a dose (e.g. 0–4h for a correction, 0–5h for a meal), predict the glucose curve from the known effects:

- insulin activity from **all** doses (this one, earlier ones still active, and Control-IQ auto-boluses);
- **basal deviation**: Control-IQ temp basal minus the programmed rate. A temp basal of 0 for an hour is a real effect;
- carb absorption from **all** carbs on board;
- the exercise effect of any session in or near the window;
- starting trend (momentum).

Then find the sensitivity, and for meals the carb ratio, that best fits the **whole** observed curve (least squares on the readings), rather than one point at 3h.

The fit also gives a residual, i.e. how much the model *couldn't* explain:
- a big unexplained rise means probably unlogged food;
- an unexplained sharp drop and rebound means a probable compression low.

Episodes with a large residual or too few readings are flagged as confounded and excluded. This mirrors how Loop/OpenAPS-style "autosens/autotune" approaches work. The builder can choose the exact fitting method, as long as the simulated-patient tests pass.

### Context stored with every episode

Time of day (London), weekday/weekend, IOB and COB at start, basal deviation during, starting glucose and trend, exercise in the previous 24h and 48h (type, minutes, TRIMP/strain), and infusion site age. From fitl00p's health data: last night's sleep, recovery and resting-HR z-score. Meal macros from fitl00p's food log when matched. Sensor age and gaps.

> **Update (owner, 2026-10-24):** "Remove the dependency on the old engine, we have the old version of the app to revert to." The archive folder and revert script were removed; the original lives only at git tag `diabetes-engine-v1`, and the way back is the previous TestFlight build. New code does not need to stay compatible with the original. The offline replay still compares against the original, loaded from the tag at run time.

## Rollout (owner's decisions, with Claude's calls marked)

1. **Archive the original (owner).**
   - Before anything changes, copy the current engine *and its tests* to `archive/diabetes-engine-v1/`: `diabetes-engine.js` and `diabetes-engine.test.js`.
   - Also tag the commit `diabetes-engine-v1`.
   - The archive is **not** in the build: not loaded by `index.html`, not in `sync-shared.mjs`, not run by `npm test`, not deployed.
2. **Replace (owner).** The new learning is written into `src/diabetes-engine.js` in place of the old learning code. Everything that calls the engine keeps the same function names and result shapes, so the app, the forecast alerts, `diabetes-sync` and the briefings need no rework.
3. **Prove offline before going live (Claude's call).**
   - Replay a past period using only data available at each moment (stored episodes plus Nightscout history). Compare the new engine's forecasts against the archived original's:
     - error at 30, 60 and 120 minutes;
     - lows predicted late.
   - The new engine must be at least as accurate overall and no worse on late lows.
   - The comparison report is saved in the repo.
   - This uses the archive as a test fixture only; it still never ships.
4. **Go live.** Deploy, then push `main` with the owner's OK. Alert and briefing wording names the learned values (goal 8). The Diabetes tab tracks live accuracy from then on, using the existing `forecastAccuracy` grading.
5. **Revert in one step (owner).**
   - `scripts/revert-diabetes-engine.mjs` copies the archived engine back over `src/diabetes-engine.js`, runs `sync-shared` and the archived tests.
   - Afterwards, redeploy the affected functions and rebuild.
   - Learned tables (`dx_episodes`, `dx_model`) are left in place and simply unused by the original, so going forward again later loses nothing.
   - The steps are written into CLAUDE.md.
6. **Fallback inside the new engine:** whenever the model is missing, stale (not refitted in 48h) or withheld, use the pump settings, exactly as the original did with too little history.

## Constraints

- Same stack and rules as the rest of fitl00p:
  - shared logic in `src/` UMD modules, synced to `supabase/functions/_shared/` by `scripts/sync-shared.mjs`;
  - `npm test` must pass;
  - production SQL recorded in `supabase/sql/`;
  - Edge Functions deployed with the CLI;
  - no push to `main` without the owner's OK.
- Times are Europe/London (BST/GMT-safe), as in the briefings work.
- Nightscout runs on the Pi at home (192.168.1.216) behind its public URL. The nightly job must tolerate it being unreachable: skip and retry next night, and never wipe the model.
- Treatments come via tconnectsync. Control-IQ basal shows as "Temp Basal" and its automatic boluses as boluses with no carbs, which the adapter currently classifies as "correction". The builder must tell auto-boluses from manual corrections where the data allows (tconnectsync marks them). Otherwise treat them as insulin activity, not as correction episodes to learn from.

## Left to the builder

- Exact fitting method (least squares, Bayesian shrinkage, how many time blocks; 8 three-hour blocks to match `REGIMEN_TOD_BUCKETS` is a sensible start). Confidence measures, and residual thresholds for "confounded".
- Table columns and indexes; how the model version history is pruned.
- How the simulated patient is built (it should include noise, sensor lag, Control-IQ-like basal changes, and unlogged snacks so the confounder detection is tested).
- Diabetes tab layout for the learned curves and the live-accuracy view.
- Whether each candidate modifier (site age, illness, sleep) clears its evidence bar. The test is a consistent effect across ≥10 episodes each way, with the effect larger than its uncertainty.

## Calls made in this design (for the owner to check)

1. **Owner:** overwrite the existing module (`src/diabetes-engine.js`); the old learning code is replaced in place, not kept in a separate file.
2. Guard band of ±30% around pump settings for dosing use; outside that it's a review finding only.
3. Asymmetric evidence thresholds: 5 episodes to suggest less insulin, 10 to suggest more. Learned values move at most 10% per day.
4. Exercise effects can only reduce suggestions or forecast lower, never increase.
5. Nightly learning at ~03:30 London; first run backfills ~90 days.
6. **Owner:** no live side-by-side run. The original is archived out of the build and restorable in one step. **Claude's call:** an offline replay against Lewis's stored history must show the new engine forecasts at least as well (and no worse on late lows) before it goes live.
7. Candidate modifiers (site age, illness or poor recovery, short sleep) only switch on when Lewis's own data shows a consistent effect.
