# Sleep sessions: naps, lie-ins, and what they do to sleep need and Body Battery

Status: APPROVED by owner 2026-11-12. Nothing built yet; next step is the implementation plan.
Calls I made myself are marked **(my call)**.

## Intent and why

The app keeps one sleep record per wake date, taken from HealthKit. That causes two real problems:

1. **Naps overwrite the night.** On Gemma's nap days the app stored the afternoon nap as her sleep for that morning. Example: 2026-11-02 shows 13:35–16:02, 2.4 h, and her overnight sleep for that morning is gone. Recovery, sleep performance and sleep debt all read the nap as the night. The cause is `sleepByWakeDate` in `ios/App/App/HealthBackgroundSync.swift`: sessions are sorted by start time, and each one writes `out[wakeDate]`, so a later nap replaces the night. `hkSleepSessionsByWakeDate` in `src/app.js` has the same rule.
2. **Sleep after the alarm is invisible or lost.** Lewy's 2026-11-12 night is recorded as 00:10–05:30 UTC. Nothing is recorded as asleep until the 07:10 wake-up, but Lewy says he slept at least an hour in that lie-in. The last sync seen was 07:05 UTC, before the wake-up, so samples written later may not have been picked up. The app also stores only start and end per day, so there is no record of when the sleep or awake periods happened.

Gemma naps most days from about 13:00 to 16:00. Her naps should count as real sleep, and they should affect tonight's sleep need and her Body Battery.

## Goals

- Store every sleep session, not one per wake date: the night, naps, and post-alarm dozes.
- Gemma's naps show in the app as naps, with their own duration, time and effect.
- The night's sleep score, sleep debt and sleep need use the night only, unless a nap is credited (below).
- Naps and dozes feed Body Battery as sleep, using the existing `simulate()` sleep inputs.
- A lie-in Lewy actually slept through can be recorded, so that the night's total and Body Battery are right.

## Non-goals

- Changing how the overnight Body Battery charge is calculated. The existing formula (per hour asleep, scaled by quality) stays.
- Naps detected from anything other than HealthKit or manual entry (no camera, no phone accelerometer).
- Retroactively fixing sleep history beyond re-syncing the last 30 days from HealthKit (see Migration).

## Anti-goals (would be a failure even if it technically works)

- A nap quietly lowering tonight's sleep need or debt without the user being able to see why.
- Overwriting a night again on any day, for any reason.
- Treating quiet rest in bed as sleep without the user saying they slept.

## Design

### Data

New table `public.sleep_sessions` (RLS: own rows only, same pattern as `health_daily`):

| column | notes |
|---|---|
| `user_id` | |
| `start_at`, `end_at` | timestamptz |
| `wake_date` | local calendar date of `end_at` |
| `kind` | `night`, `nap`, or `doze` (see classification) |
| `source` | `healthkit` or `manual` |
| `asleep_hrs`, `deep_hrs`, `rem_hrs`, `core_hrs` | numbers |
| `received_at` | when the sample set reached the server |

Unique key: `(user_id, source, start_at)`. Re-sync upserts, so no duplicates.

`health_daily.sleep_*` stays as it is. It is the **night** session for that wake date, so the widgets, briefings and readiness code keep working unchanged. Naps are not written there.

### Classification (applied on the device, then sent)

Sessions are the existing 90-minute grouping of asleep segments, unchanged. Each session is then labelled:

- **night**: the longest session ending before 12:00 local on the wake date, starting after 18:00 the day before. (**my call**)
- **doze**: a session starting within 2 h after the night ends (for example, after the alarm). (**my call**)
- **nap**: any other session with at least 15 minutes asleep. (**my call**)

Every session is kept. Nothing is dropped by a later one.

### Lie-ins (the 05:30 / 07:10 case)

Two parts, one of which the owner must choose.

- The alarm time is not read from the Watch or Clock, since iOS does not expose it to apps. The app can take it from a setting (the time the owner usually sets) or from the user's entry.
- Capture options (**Theirs**, see below):
  - **A.** A prompt after the alarm time, roughly 15 min after the alarm if the phone is still asleep-ish: "Did you doze after 05:30? Set start and end." Prefilled from the alarm setting.
  - **B.** A manual "Add sleep" entry only, with start and end times.
  - **C.** Trust HealthKit only. No lie-in capture. The lie-in stays invisible.

Whatever is chosen, a manual session has `source = manual` and never overwrites a HealthKit session. Both are kept.

### Factoring naps into sleep need

- **Tonight's need.** A nap starting after 15:00 credits back **50% of its asleep hours, capped at 1 h** (**my call**). A nap before 15:00 credits nothing (it's too early to reduce tonight's pressure).
- **Sleep debt (7-night window).** Night sessions count in full. Naps count at 50% toward the 7-night total, with the same cap as above (**my call**).
- **Dozes.** A doze counts as part of the night it follows, since it comes straight after the alarm. It adds to that night's asleep total and to Body Battery sleep time, not as a nap (**my call**).
- The displayed sleep performance is still for the night only. The app shows the nap credit as its own line, e.g. "Nap: +0.5 h credited to tonight".

### Body Battery

`simulate()` already takes `sleeps` as an array of `{ start, end, asleepHrs, quality }`. Naps and dozes go in the same array as the night:

- Quality for a nap or doze: `quality = 1` for now. Day-time HRV is not in the model, so the overnight `sleepQuality` function can't be applied. Revisit if the data shows naps are consistently off (**my call**).
- Gemma's 13:35–16:02 nap (2.4 h asleep) gives roughly +18 percentage points at the current rate of 7.5 per hour, before the cap at 100. Worth checking against her real data once the sessions are stored.
- Quiet awake rest in bed after the alarm already counts as rest through the existing heart-rate logic (`restHrr`), so a lie-in with no sleep is not lost completely.

### Sync and code changes

- `ios/App/App/HealthBackgroundSync.swift`: `sleepByWakeDate` returns an array of sessions, each with a kind, instead of a dict keyed by wake date. Sends the night as the existing `health_daily` fields, and every session to the new table.
- `src/app.js`: `hkSleepSessionsByWakeDate` gets the same change (the web fallback still reads `health_daily`).
- `health-ingest` Edge Function: accepts a sessions array and upserts it.
- Server copies of readiness and briefings: unchanged, since they read the night from `health_daily`. Add a sessions read only where naps are credited (tonight's need and debt).
- `src/readiness-model.js` (and its `_shared` copy): accept the nap credit as an optional input. `npm test` must pass.

### Migration

- The overwritten nights cannot be recovered from the server. HealthKit still has the samples, so the app re-syncs the last 30 days from the device after the iOS build is installed. This is a one-off backfill, run on each phone.
- Each user's phone must install the new build before the backfill is complete. Until then, old behaviour continues and new sessions are not written.

### Tests

- Unit tests on the classifier using the real cases:
  - Gemma 2026-11-02: night 23:08 → 07:09 on 11-03 is one night. The 13:35–16:02 session is a nap. Nothing overwrites either.
  - Gemma 2026-11-08: the 11.99 h session from 13:16 on 11-07 is checked against the raw segments before classifying (it may be a nap merged into a night).
  - Lewy 2026-11-12: night 00:10–05:30; a manual doze 05:30–07:10 becomes a doze if entered, and nothing if not.
- Readiness: a nap after 15:00 changes tonight's need by the expected 50% credit, capped at 1 h.
- Body Battery: a nap adds sleep gain, and a night with a nap does not lose the night's gain.

### Delivery

- Database migration (SQL under `supabase/sql/`, recorded there).
- `health-ingest` and any changed Edge Functions deployed via the CLI.
- iOS and web changes need a TestFlight build from `main`. **Pushing `main` needs the owner's explicit yes** (CLAUDE.md).

## Decided by the owner (2026-11-12)

1. **Lie-in capture (approved):** option A, a one-tap prompt after the alarm, prefilled with the alarm time and a suggested end time. Ignoring it changes nothing.
2. **Nap credit (approved):**
   - Sleep debt (7-night window): naps count at 75% of asleep hours.
   - Tonight's need: 25% of asleep hours, capped at 30 min, only if the nap ends by about 16:30. Later naps give no tonight credit.
3. **Dozes count as part of the night.** Dozes are flagged for the owner to confirm after the prompt.
4. **Naps show on the dashboard and in Body Battery** as a separate "+" line. Night-only sleep numbers are unchanged.

## Calls made without you (review these)

- Night / doze / nap rules and time windows (the 12:00 wake cut-off, 2 h doze window, 15 min minimum for a nap).
- Naps and dozes use `quality = 1` in Body Battery for now.
- The tonight-credit numbers above (25%, 30 min cap, 16:30 cut-off). Debt credit is 75%, as approved.
- Backfill covers the last 30 days only.
