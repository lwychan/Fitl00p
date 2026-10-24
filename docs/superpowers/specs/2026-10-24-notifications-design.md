# Notifications redesign — morning & evening briefings built from parts

Date: 2026-10-24 · Status: draft for review · Owner: Lewis (app owner, one of two users; Gemma is the other)

## Intent

Replace today's scattered pushes (07:00 summary, 20:00 sleep target, separate weigh-in / meds / peptide / Tirzepatide reminders) with **one morning and one evening message per person** that read like a coach who looked at all the numbers — e.g. *"Recovery 31 after only 5h sleep, and HRV's been down all week. Take it easy — light walk today."*

Why: the old AI coach briefing cost tokens and has been removed. The owner explicitly does **not** want live AI or free third-party AI APIs (cost, data privacy, unreliable free tiers, unvetted health/diabetes wording). All wording must come from guidance we control: the existing `insight_rules` table.

## Goals

1. **Compositional messages, no AI.** A message is assembled from parts: headline (the score that matters most) + up to two "why" reasons that actually apply + one action. Parts come from `insight_rules`; a tested pure function joins them by priority. Same numbers → same message.
2. **Morning briefing**, per person, at their wake time (built from last night's data).
3. **Evening briefing**, about an hour before their suggested bedtime: suggested sleep + bedtime, a summary of the day and what it means, a workout line from Hevy, pending meds.
4. **Fewer pings**: roughly 40+ possible on a bad day today → ~3–5, each saying something useful.
5. **Sleep-data fallback**: if last night's sleep hasn't synced by send time, estimate from what the server has and say so ("probably").

## Non-goals

- No live AI / LLM calls, free or paid. (Apple on-device AI was discussed and parked as possible later polish.)
- No change to custom metric alerts (`notify-metric-check`) — user-configured, left as is.
- No new data collection beyond the evening snapshot and Hevy top sets described below.
- Not rewriting the glucose forecast's prediction maths — only its wording and its deploy.

## Anti-goals (would make this a failure even if it "works")

- Presenting a guess as fact (fallback must say "probably" / "no sleep data yet").
- Dosing instructions in the briefings. Diabetes lines in the morning/evening briefings stay informational and point to the Diabetes tab (hypo treatment per the user's own plan is the only action).
- **Owner-decided exception — the high-glucose forecast alert keeps its correction suggestion** ("consider ~X.Xu, check IOB first"). The owner wants the app to learn how his body reacts to insulin and carbs and to use that history to shape suggestions. So the suggested amount must come from the diabetes engine's *learned* personal values (resolved past corrections → `personalCorrectionFactor` / retrospective correction; meal memory for carbs), with the configured profile factor only as a fallback when there isn't enough history — and the alert should say which it used (e.g. "based on your last 12 corrections" vs "using your set factor"). It stays phrased as a suggestion ("consider"), always shows insulin on board, and never fires during an active hypo or while glucose is falling.
- More notifications than today, or repeats after the thing is done (e.g. reminder after Tirzepatide is logged).
- Messages built from stale data without saying so.
- Messages too long for the lock screen (~2 lines; target ≈ 120–180 chars body).

## Who and when (decided by the owner)

| Person | Morning briefing | Evening briefing |
|---|---|---|
| Lewis | **05:45 Mon–Fri**, **07:30 Sat–Sun** (Europe/London) | ~1 hour before suggested bedtime |
| Gemma | **07:30 every day** | ~1 hour before suggested bedtime |

- Lewis trains ~06:00 on weekdays and wakes 05:30; 05:45 gives sleep 15 min to end and Apple Health time to background-sync.
- Wake times used for bedtime maths: Lewis 05:30 weekdays / 07:30 weekends; Gemma 07:30. Both editable in Settings (see Constraints).
- Suggested bedtime = next morning's wake time − tonight's sleep need (`computeSleepNeed`: 8h baseline + strain hours + decayed debt). Evening briefing fires ~60 min before that bedtime. Builder's call on a clamp (e.g. never before 19:00 or after 23:00).
- One morning and one evening briefing per person per day; never repeated.

## Message structure (parts)

Each relevant `insight_rules` row gains optional short phrases (new columns):

- `headline` — e.g. `Recovery {recovery}` / `You've recovered well ({recovery})` (only some rules; the top-priority rule with a headline wins).
- `reason` — a clause that can follow a headline, e.g. `after only {sleep_hrs:1}h sleep`, `HRV's been down all week`, `resting HR is up`.
- `action` — an imperative, e.g. `Take it easy — light walk today`, `Push hard today`.
- `slot` — which briefing(s) the rule may appear in: `morning`, `evening`, `both`, `app` (app card only). Existing app-card behaviour is unchanged.

Composer (pure function in `src/insights.js`, shared to the server via `scripts/sync-shared.mjs`, unit-tested):

1. Evaluate rules for the slot with the current context (existing `evaluateInsights` machinery).
2. Headline: from the highest-priority match that has one.
3. Reasons: next up to 2 matches with a `reason`, de-duplicated by category, joined naturally ("after X, and Y").
4. Action: from the highest-priority match that has one (safety categories — `glucose`, `health`, `diabetes` — outrank training advice).
5. Extra lines (appended, each short): reminders (weigh-in, peptide, Tirzepatide due, meds pending), workout line (evening), fallback note.
6. Tone follows the top rule's severity (good → upbeat; warn → direct).

Examples (illustrative wording, final wording lives in the rules JSON):

- Morning, rough: *"Recovery 31 after only 5h sleep, and HRV's been down all week. Take it easy — light walk today."*
- Morning, good: *"You've recovered well (78). Push hard today."* + *"⚖️ Weigh-in day."*
- Evening: *"In bed by 21:05 (8.4h — catching up on sleep debt). Strain 14.2, over target on low recovery; Body Battery 22%."* + *"Upper B: 7,360 kg, +95 kg on last time; shoulder press top set +2.5 kg."*

## Data the briefings use

Server-side (Edge Functions, pg_cron), all already available unless noted:

- `health_daily` (sleep, HRV, resting HR, respiratory rate, wrist temp, steps, energy, weight), `apple_health_workouts`, `food_log` / `daily_logs`, `profiles` (incl. `recovery_weights`), `readiness_checkins`, `insight_rules`.
- Glucose: Nightscout via the same path `diabetes-sync` uses (server-side, independent of the phone).
- `hevy_workouts` — per-workout `routine_id`, `title`, `volume_kg`, `set_count`, `exercises` jsonb. **New:** per-exercise heaviest working set (weight kg) stored in `exercises` jsonb by `hevy-sync` (Hevy's API already returns set weights; the sync currently discards them).
- **New: evening snapshot** — when the app is opened after ~20:00 (and on each Body Battery recompute after that), it upserts one row per user per day: Body Battery %, time, today's strain so far, today's Body Battery parts. Builder decides table shape (e.g. `readiness_snapshots(user_id, snap_date, taken_at, battery, strain, …)` with RLS own-rows).

### Sleep-data fallback (morning only, only when needed)

"Needed" = today's `health_daily` row has no `sleep_total_hrs` (or it clearly isn't last night's) at send time. Then the morning briefing:

- uses last evening's snapshot (Body Battery at last open, time of last app use as a rough bedtime hint, strain), and
- overnight glucose (00:00–06:00 London): steady/no lows = "probably settled"; lows or big swings = "probably broken".
- says so plainly: *"No sleep data from last night yet — probably a short but settled night (bed ~23:40 on 32%, glucose steady)."*
- never claims a sleep duration it doesn't have; Recovery is shown only if HRV/RHR did sync.

## Reminder changes (decided by the owner)

| Reminder | Today | New |
|---|---|---|
| Tirzepatide | hourly 09–21 on due day until logged (up to 13) | **Separate notification.** Line in morning briefing on due day; then **12:00, 15:00, 17:00, 19:00 only if not yet logged**; stops once logged |
| Peptide | every 30 min 07:30–21:30 until logged (up to 28) | Line in morning briefing; **one mid-afternoon nudge** if not logged; **last call inside the evening briefing** |
| Weigh-in (Lewis Tue 10:00; Gemma daily) | separate | **Line inside that day's morning briefing** (Lewis Tuesdays, Gemma daily) — no separate push |
| Evening meds | 21:00 separate | **Mentioned in the evening briefing**; separate 21:00 push **only if still not logged** |
| Glucose forecast | old code, can't deliver | Stays real-time and separate; **reworded from parts** (e.g. *"Dropping to 4.1 in 30 min — 1.8u still active, have 15g carbs ready."*); deployed via CLI |
| 07:00 summary / 20:00 sleep target | separate | **Replaced** by morning / evening briefings |
| Custom metric alerts | — | Unchanged |

## Constraints

- **Backend:** Supabase Edge Functions (Deno) in `supabase/functions/`, shared code in `_shared/`, scheduled with pg_cron via `private.invoke_edge_fn`. Pushes go through `_shared/webpush.ts` (`sendToSubscriptions`), APNs key from Vault (`get_apns_p8`).
- **Shared logic** lives in UMD modules in `src/` (`insights.js`, `readiness-model.js`, `body-battery.js`), unit-tested with `node --test`; server copies generated by `node scripts/sync-shared.mjs` (never hand-edit `_shared/*.js`). `npm test` must pass.
- **Rules source of truth:** `supabase/seed/insight-rules.json` → `node scripts/build-insight-rules.mjs` (validates) → `supabase/sql/insight_rules_seed.sql`. New columns must be validated there too (template keys must exist in `METRICS`).
- **Timezone:** schedule in Europe/London (`londonNow()`), robust across BST/GMT changes. Cron runs at least every 15 min; each function decides per user whether it's their minute (existing pattern: `notification_prefs` has `check_hour`, `check_minute`, `days_of_week`).
- **Per-person times** go in `notification_prefs` (new keys, e.g. `morning_briefing` with weekday/weekend times; wake times for bedtime maths). Settings UI should let each person edit them; defaults as in the table above. Builder decides the exact columns/keys.
- **Delivery reality:** Apple Health reaches Supabase only when iOS wakes the app (background delivery, at most ~hourly) or the app is opened. Hence the fallback.
- **Body Battery** is computed only on the phone (`src/body-battery.js`); the server only knows what the snapshot stored.
- **Deploys:** Edge Functions via `npx supabase functions deploy` once the owner has run `npx supabase login` on the laptop (MCP deploy works but large files are impractical). `notify-glucose-forecast` and `diabetes-sync` need the CLI (176 KB engine).
- **Push to `main`** (triggers the TestFlight build) only with the owner's explicit OK (CLAUDE.md).
- Notification body ≈ 2 lines on the lock screen.

## Calls made after the builder check (Claude's calls, owner to confirm)

- **Snapshot trigger:** the app upserts the day's snapshot on *every* open/Body Battery recompute (one row per user per day, latest wins), not only after 20:00 — so an evening briefing at ~20:05 still has Body Battery as of the last app open. If no snapshot exists that day, the evening briefing omits the Body Battery line.
- **Meds / peptide vs a late evening briefing:** if the person's evening briefing is due before 21:00 it carries meds + peptide last call, and the separate 21:00 meds push fires only if still unlogged. If the briefing is due after 21:00, the 21:00 push is skipped and the briefing carries it. No reminder is ever sent after the thing is logged.
- **Glucose forecast wording:** built from parts in code (a small template in the forecast function), not in `insight_rules` — its values (forecast glucose, minutes to threshold, carbs) aren't briefing metrics and it fires outside the briefings.

## Owner review checkpoint (decided by the owner)

New wording for the safety categories (`glucose`, `health`, `diabetes` headline/reason/action phrases) is **reviewed by the owner before it goes live**. The plan must pause after writing those phrases in `insight-rules.json` and before running the seed SQL for them. Briefings may launch with only the non-safety phrases enabled until the owner approves.

## Left to the builder

- Exact table/column names for the snapshot and the new `insight_rules` columns; `notification_prefs` key design.
- Join grammar for reasons ("after X, and Y" / "X and Y") and punctuation, as long as output stays short and natural.
- The priority order between categories within a briefing, within the rule: safety (glucose/health/diabetes) first.
- Whether morning/evening are two functions or one function with a slot parameter; old `notify-daily-summary` / `notify-sleep-target` / weigh-in functions retired (cron unscheduled, functions deleted) once replacements are live.
- Test fixtures: at least the examples above as composer tests, the fallback path, Tirzepatide stop-once-logged, and the 05:45 weekday / 07:30 weekend scheduling across a BST change.
- Settings UI layout for the new times.
