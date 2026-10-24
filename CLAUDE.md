# Fitl00p

## Deployment — ask before doing it

**Never push to `main` (or trigger a Netlify deploy through any tool) without asking the user first and getting an explicit yes.** `main` is (or will be) linked to Netlify as the production branch, so a push there — or any direct deploy call — consumes build minutes/credits automatically. This applies regardless of how confident the change is or how small it looks.

Pushing to feature/working branches is fine without asking, since that alone doesn't deploy anything (unless Deploy Previews/branch deploys are enabled for all branches — check before assuming that's still true).

## Layout

The actual app lives in `src/`, not the repo root — `index.html`, `app.js`, `app.css` are all under `src/`. Netlify only hosts `src/` statically (web PWA + `privacy.html`); base directory `src`, `netlify.toml` declares `publish = "."` and nothing else — no Netlify functions or schedules.

All backend code is Supabase Edge Functions in `supabase/functions/` (shared code in `_shared/`), scheduled via pg_cron (`private.invoke_edge_fn`). One-off SQL applied to production is recorded in `supabase/sql/`. The iOS app is Capacitor (`ios/`), built by Codemagic from `main`.

## Shared logic and tests

Pure logic lives in small UMD modules in `src/` (loaded by `<script>` tags before `app.js`, unit-tested in `tests/` — run `npm test`):

- `diabetes-engine.js`, `nightscout-adapter.js`, `readiness-model.js` (Recovery z-scores, sleep debt, check-in weight learning, max HR) — also used by Edge Functions: `node scripts/sync-shared.mjs` writes the copies in `supabase/functions/_shared/`. Never edit those copies; `npm test` fails if they're stale.
- `body-battery.js` (Body Battery simulation), `insights.js` (rule matching + the metrics rules can use), `food-utils.js`.

New `src/*.js` modules also go in `sw.js`'s `NEVER_CACHE` list.

## Insight rules

The dashboard's Insights card (and the Body Battery popup's suggestions) come from `public.insight_rules`, not live AI. To change them:

1. Edit `supabase/seed/insight-rules.json` (metrics a rule can use are listed in `METRICS` in `src/insights.js`).
2. `node scripts/build-insight-rules.mjs` — validates every rule and regenerates `supabase/sql/insight_rules_seed.sql`.
3. Run that SQL against the project. The app picks the change up on next launch — no app release needed.
