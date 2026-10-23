# Fitl00p

## Deployment — ask before doing it

**Never push to `main` (or trigger a Netlify deploy through any tool) without asking the user first and getting an explicit yes.** `main` is (or will be) linked to Netlify as the production branch, so a push there — or any direct deploy call — consumes build minutes/credits automatically. This applies regardless of how confident the change is or how small it looks.

Pushing to feature/working branches is fine without asking, since that alone doesn't deploy anything (unless Deploy Previews/branch deploys are enabled for all branches — check before assuming that's still true).

## Layout

The actual app lives in `src/`, not the repo root — `index.html`, `app.js`, `app.css` are all under `src/`. Netlify only hosts `src/` statically (web PWA + `privacy.html`); base directory `src`, `netlify.toml` declares `publish = "."` and nothing else — no Netlify functions or schedules.

All backend code is Supabase Edge Functions in `supabase/functions/` (shared code in `_shared/`), scheduled via pg_cron (`private.invoke_edge_fn`). One-off SQL applied to production is recorded in `supabase/sql/`. The iOS app is Capacitor (`ios/`), built by Codemagic from `main`.
