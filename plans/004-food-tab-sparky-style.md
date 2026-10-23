# 004 — A "Food" tab modelled on SparkyFitness, keeping the dose linkage

- **Written against:** `aa381de` (branch `audit-fixes`, which already removed the AI photo/describe modes — this plan assumes that branch).
- **Category:** direction (feature) · **Impact:** High (daily-use screen) · **Effort:** L · **Risk of fix:** Medium — every food_log write must keep calling the diabetes bridge, or dose suggestions silently lose meals.
- **Decided by the user (2026-10-23):** build a SparkyFitness-*style* tab inside FitLoop on Supabase. Not self-hosting SparkyFitness, not embedding it, not syncing from it. (SparkyFitness is source-available/non-commercial, needs Postgres 18 + Node + Docker, and its diary API is undocumented — see the audit notes in `plans/README.md`.) Borrow its UX ideas; copy none of its code.

## What changes for the user

Today food logging is a sub-screen: Dashboard → "+ Log food" (`src/index.html:511`) opens `#viewLogFood` (`src/index.html:1717`), which has a ← Back button, shows **today only**, and hides the tab bar.

After this plan:

1. A **Food** tab in the bottom tab bar, between Dashboard and Diabetes. "+ Log food" on the dashboard just switches to it.
2. **Diary by day** with ‹ date › navigation (default today). Every section and total follows the chosen day.
3. **Daily summary** at the top: calories eaten / goal / remaining, and protein, carbs and fat against the existing targets (`computeMacroTargets()` at `src/app.js:12280`). Reuse the current "Today's totals" and "Remaining" cards, made date-aware.
4. **Meal sections** Breakfast · Lunch · Dinner · Snacks (+ Hypo Treatment when diabetes is on — keep `LF_SECTIONS` / `lfSectionOf` at `src/app.js:13087-13102`). Each shows its kcal and macros, its items, and an **Add food** button. All of this already exists in `renderLfTodayList()` (`src/app.js:13229`).
5. **Add food** opens a sheet with: **Recent** (the last 20 distinct foods you logged — new), **Saved meals** (new, below), **Search** (custom foods + Open Food Facts — exists), **Scan** (exists), **Manual** (exists). The picked food lands in the existing review form, then **Log it**.
6. **Saved meals** (Sparky's "custom meals"): save a whole section ("Save Breakfast as a meal…") and re-add it to any section in one tap. This replaces the single-item Favourites `<select>`; migrate existing `favorite_meals` rows as one-item saved meals.
7. **Copy** a section from the previous day (the button exists as "Copy yesterday's X"). Generalise it to "copy from the previous day" relative to the *selected* date.

**Out of scope** (say so in the PR; candidates for later plans): USDA FoodData Central as a second search provider, micronutrients (fibre/sugar/sodium), water, custom meal categories, sharing a diary, and moving `log_date` from UTC to local days (see "Known issue" below).

## The non-negotiable: the diabetes bridge

Every write to `food_log` goes through `bridgeLfMealChange(logDate, mealSlot, isHypo, foodLogId, item)` (`src/app.js:8006`), which keeps `diabetes_meals` in step. Snacks are dosed per item (`upsertDiabetesMealItem`, `:7932`); every other section is re-aggregated from `food_log` (`upsertDiabetesMealSection`, `:7823`). Existing call sites that must survive the move unchanged in behaviour:

| Write | Where today | Bridge call |
|---|---|---|
| Log a new item | `btnLfSave` handler (`:12744`) | after insert |
| Edit an item (incl. slot/date change) | same handler, `lfEditingFoodLogId` set; `lfEditingOriginal` holds the old slot/date | old section **and** new section |
| Delete | `lfTodayList` click, `food-delete` (`:13282-13294`) | after delete, `item = null` |
| Change time | `saveLfLoggedTime` (`:13341-13372`) | both days if the UTC date changes |
| Copy yesterday | `btnLfCopyYesterday` handler (`:13135`) | per inserted row |
| Share with partner | `share-food-log` Edge Function | server-side, already bridges |

New write paths in this plan (re-adding a saved meal, adding from Recent) **must** call `bridgeLfMealChange` the same way: insert all rows, then bridge per row for `snack`, once for the section otherwise.

Write a short helper and use it for every multi-row insert, so the rule lives in one place:

```js
// Inserts food_log rows for one section and keeps diabetes_meals in step.
async function insertFoodRowsAndBridge(rows) { /* insert ... select('id'); then bridge per policy above */ }
```

Note: `rows[i].log_date` must be the **selected diary date**, not `todayISO()`.

## Steps

Do these in order. Commit after each, and run the checks every time.

1. **Date state.** Add `let lfDiaryDate = todayISO();` near the other `lf*` state (`src/app.js:~12323`). Replace `fetchTodayFoodLog()` (`:12956`) with `fetchFoodLogFor(date)`, keeping the old name as a one-line wrapper until all callers move. Make `renderLfTodayTotals`, `renderLfTodayList`, the Remaining card and `updateLfCopyYesterdayButton` use `lfDiaryDate`. Default `logged_at` for a new item on a past date = that date at the current time of day.
   Check: on today, behaviour is unchanged (screenshot before and after).
2. **Tab.** In `src/index.html`, add a Food `tab-btn` (`data-view="logFood"`) in `#tabBar` (`:1879`), copying the markup of the Workout button. Remove the ← Back button (`:1720`). In `src/app.js`, add `'logFood'` to `mainTabs` in `navigateTo` (`:1539`) so the tab bar stays visible.
   Check: tapping the tab and the dashboard's "+ Log food" both open the diary with the tab bar showing.
3. **Date navigator.** Add ‹ date › controls to the view head, plus a "Today" shortcut. Re-render the summary and sections on change.
4. **Add-food sheet + Recent.** Move the mode pills (`#lfModePills`) into a sheet opened by each section's Add button, pre-setting the meal slot (the existing `lf-section__add` handler at `:13266` already does this). Add **Recent**: `select food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, custom_food_id, barcode from food_log where user_id = me order by logged_at desc limit 200`, de-duplicated client-side by `food_name+brand`, top 20. Picking one fills the review form via `populateLfFormFromFood` (`:12626`).
5. **Saved meals.** New table (record the SQL under `supabase/sql/`):

   ```sql
   create table public.saved_meals (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references auth.users on delete cascade,
     name text not null,
     items jsonb not null,           -- [{food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, custom_food_id, barcode}]
     created_at timestamptz not null default now()
   );
   alter table public.saved_meals enable row level security;
   create policy "own saved_meals" on public.saved_meals for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
   insert into public.saved_meals (user_id, name, items)
     select user_id, name, jsonb_build_array(jsonb_build_object('food_name', name, 'brand', brand, 'serving_desc', serving_desc, 'quantity', 1,
       'calories_kcal', calories_kcal, 'protein_g', protein_g, 'carbs_g', carbs_g, 'fat_g', fat_g, 'barcode', barcode))
     from public.favorite_meals;
   ```
   Add "Save as meal" to each section's header (needs at least 1 item) and a Saved meals list in the add sheet. Re-adding a meal uses `insertFoodRowsAndBridge`. Keep `favorite_meals` and its UI until this ships and the user confirms. Removing them is a follow-up.
6. **Copy from previous day.** Generalise `fetchYesterdaySectionItems` (`:13110`) to "the day before `lfDiaryDate`", and route its inserts through `insertFoodRowsAndBridge`.
7. **Header comment.** Rewrite the `LOG FOOD` block comment (`src/app.js:12244`). It still describes a "Claude vision estimate", which was removed in `e1fa305`.

## Checks (after every step)

- `node --check src/app.js` → exit 0.
- `npm test` → all pass (engine tests plus the shared-copy check).
- **Bridge check, run after steps 1, 4, 5 and 6.** For a test day, log a Breakfast item, a Snack item and a saved meal into Lunch. Edit the Breakfast item into Lunch, delete the Snack, then run:

  ```sql
  select meal_slot, carbs_g, food_log_id from diabetes_meals
  where user_id = '<you>' and eaten_at::date = '<day>' order by eaten_at;
  ```
  Expected: one Lunch row whose `carbs_g` equals the sum of that day's Lunch `food_log` carbs, **no** Breakfast row (it's empty now), and no row for the deleted snack.

## Test plan

Pure logic gets tests in the style of `tests/diabetes-engine.test.js` (`node:test`, `require` the file):
- If you extract the Recent de-dupe or the "copy previous day" date maths into a small pure function, put it in `src/food-utils.js` (UMD like `src/nightscout-adapter.js`, loaded with a `<script>` tag before `app.js`) and test it in `tests/food-utils.test.js`.
- The bridge is covered by the SQL check above. There is no DOM test harness, so don't build one for this.

## Known issue, deliberately not fixed here

`food_log.log_date` is a **UTC** date (`todayISO()` uses `toISOString()`). In UK summer time, food logged between 00:00 and 00:59 local lands on the previous day's diary, and the diabetes bridge uses the same UTC days. Moving to local dates touches `diabetes_meals` matching and history, so it needs its own plan. Don't "fix" it piecemeal here.

## Escape hatches

- If any write path can't call the bridge as in the table above, stop and report. Never ship a write path without it.
- If `computeMacroTargets()` can't take a date (it uses today's weight), use today's targets for every day and note it.
- If the add-food sheet fights the existing barcode scanner's camera lifecycle (`stopBarcodeScan` on mode change), keep Scan as an inline panel and report.
