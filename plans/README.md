# FitLoop improvement plans

Produced 2026-10-23 by applying the `shadcn/improve` method (full audit → vetted findings → plans) to `aa381de` on branch `audit-fixes`. Read-only audit: the only files written are under `plans/`.

Recon facts every plan relies on:
- Vanilla JS PWA in `src/` (no build step) wrapped by Capacitor 8 for iOS. Backend: Supabase project `nxawnkpzjixishcerxcv` (Postgres + RLS, Edge Functions in `supabase/functions/`, pg_cron jobs).
- Verification gates: `node --check src/app.js`, `npm test` (node:test dose-maths tests + `scripts/sync-shared.mjs --check`). No linter, no CI; Codemagic builds TestFlight from `main` on manual start.
- One-off production SQL is recorded under `supabase/sql/`. Pushing to `main` needs the user's explicit yes (`CLAUDE.md`).
- Two real users (Lewis = admin, Gemma = approved). The app has a public sign-up screen (`src/app.js:1058`), so "any signed-in account" includes strangers waiting for approval.

## Findings (vetted, ordered by leverage)

| # | Finding | Category | Impact | Effort | Risk | Evidence |
|---|---|---|---|---|---|---|
| 1 | Stored XSS in the admin approval list: any account can write its own `approval_requests.name/email`, rendered unescaped in the admin's session | security | High | S | Low | `src/app.js:11915-11922`; RLS `approval_requests` INSERT `with_check (auth.uid() = user_id)` |
| 2 | `exercise_media` is writable by **every** signed-in account; `gif_url` and `matched_name` go into HTML unescaped for both users | security | High | S | Low | policy "Authenticated users can write exercise_media" (ALL, true/true); `src/app.js:5100-5103`, `5711-5713` |
| 3 | Nightscout API is readable without credentials (full glucose history) | security / privacy | High | S–M | Med | `GET https://lewyns.duckdns.org/api/v1/entries.json?count=1` → 200 (2026-10-23) |
| 4 | More unescaped household/third-party text in templates (routine names/notes/descriptions, ExerciseDB names, error messages) | security | Med | S | Low | `src/app.js:4458,4466,5244,5257,5359,6047,11698,11735,11742,10769,13772` |
| 5 | No Content-Security-Policy, so any XSS above runs with full access | security (defence in depth) | Med | M | Med | `src/index.html` has no CSP meta; `src/netlify.toml` headers don't set one |
| 6 | Nightscout token/secret travel in the `diabetes-sync` URL query, so they'd land in Supabase request logs | security | Med | S | Low | `src/app.js:8232-8235, 8262-8265` |
| 7 | Food diary days are **UTC** dates: in UK summer time, 00:00–00:59 local entries land on the previous day (diabetes bridge uses the same UTC days) | correctness | Low–Med | M | Med | `src/app.js:664` (`todayISO` = `toISOString`), `upsertDiabetesMealSection` `:7823` |
| 8 | TestFlight builds run without `npm test` | DX | Med | S | Low | `codemagic.yaml:69-74` |
| 9 | Unused native deps `@capacitor/camera`, `@capacitor/filesystem` (no `Plugins.Camera/Filesystem` use left); stray `fitl00p-updated.zip` tracked since July | deps / debt | Low | S | Low | `package.json`; `git log -- fitl00p-updated.zip` → `b79d6ee` |
| 10 | Stale docs: Log Food header still describes the removed Claude photo estimate; `CHECKLIST.md` "Current state" predates the 2026-10-23 removals | docs | Low | S | Low | `src/app.js:12244`; `CHECKLIST.md` top |

### Direction (user decision already made)

- **D1 — Food tab, SparkyFitness-style, built into FitLoop** (chosen by the user 2026-10-23). The alternatives were (a) self-host SparkyFitness and embed + sync it, and (b) use the Sparky app and sync meals in. Both were rejected: SparkyFitness needs Postgres 18 + Node + Docker (the Pi 2 is 32-bit, and the Pi 4 has 2 GB and is already memory-tight), its licence is source-available/non-commercial, and its diary endpoints are undocumented (API keys only cover `/api/health-data`), so a sync would be fragile. → plan 004.
- **D2 — Native push via APNs** is already in progress (needs the Apple key + deploy); not re-planned here.

## Plans (recommended order)

| Order | Plan | Status | Depends on |
|---|---|---|---|
| — | [001 — Escape untrusted text before innerHTML](001-escape-untrusted-html.md) (findings 1, 4) | **won't do** (user 2026-10-23: TestFlight-only, trusted users) — except step 4 (ExerciseDB names/GIF URLs), folded into 002 | — |
| — | [003 — Nightscout requires a token; token goes in a header](003-close-public-nightscout.md) (findings 3, 6) | **won't do** (user 2026-10-23: public glucose data is acceptable) | — |
| 1 | [005 — Run tests before TestFlight builds](005-run-tests-before-testflight-build.md) (finding 8) | todo | — |
| 2 | [002 — Lock down `exercise_media` writes](002-lock-exercise-media-writes.md) (finding 2) + 001 step 4 | todo | — |
| 3 | [004 — Food tab, SparkyFitness-style](004-food-tab-sparky-style.md) (D1) | todo | after 005 (tests gate the build) |

```
001 ──┐
002 ──┼──> 004
005 ──┘
003 (independent)
```

Not planned (small enough to do directly, or needs a separate decision): 5 (CSP — audit inline scripts/styles first), 7 (UTC→local days — its own design), 9, 10.

## Considered and rejected

- *Pending users can upsert their own `approval_requests.status = 'approved'`.* True, but access is gated by `profiles.role` (now locked, see `supabase/sql/audit_2026_10_23.sql`), not by `status`. Cosmetic only.
- *Food search results render OFF names unsafely.* They are escaped (`lfSearchResultButton`).
- *`hevy-sync` could skip workouts edited during a run.* No: the cursor is captured before fetching and only advances after a successful write.
- *Performance of the dashboard's ~10 parallel queries.* Fine for 2 users; no evidence of a problem.
- Items already fixed on this branch (Ponytail audit): role self-promotion, `signal_outcomes`, offline-queue race, Netlify leftovers, duplicated engine/helpers.

## Not audited

iOS Swift (`HealthBackgroundSync.swift`, widgets, Watch app), diabetes maths beyond the tested dose path, `sw.js` caching in depth, most dashboard rendering code, on-device performance, Supabase Auth settings (whether sign-up is actually open; leaked-password protection is known to be off).
