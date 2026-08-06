# Fitl00p

## Deployment — ask before doing it

**Never push to `main` (or trigger a Netlify deploy through any tool) without asking the user first and getting an explicit yes.** `main` is (or will be) linked to Netlify as the production branch, so a push there — or any direct deploy call — consumes build minutes/credits automatically. This applies regardless of how confident the change is or how small it looks.

Pushing to feature/working branches is fine without asking, since that alone doesn't deploy anything (unless Deploy Previews/branch deploys are enabled for all branches — check before assuming that's still true).

## Layout

The actual app lives in `src/`, not the repo root — `index.html`, `app.js`, `app.css`, and `netlify/functions/` are all under `src/`. When configuring Netlify (or explaining how to), the base directory is `src`; `netlify.toml` (also under `src/`) declares `publish = "."` and `functions = "netlify/functions"` relative to that base.

Netlify functions call the Anthropic API directly (see `src/netlify/functions/food-photo-estimate.js`) and read/write Supabase via `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`. Required env vars are listed in a comment block near the top of `src/netlify.toml`.
