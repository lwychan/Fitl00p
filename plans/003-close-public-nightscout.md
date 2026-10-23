# 003 — Make Nightscout require a token, and keep the token out of URLs

- **Written against:** `aa381de` (branch `audit-fixes`).
- **Category:** security (health data privacy) · **Impact:** High · **Effort:** S–M · **Risk of fix:** Medium (a mistake stops glucose syncing — test before walking away)

## Why

1. **Glucose data is public.** `GET https://lewyns.duckdns.org/api/v1/entries.json?count=1` with no credentials returned HTTP 200 and a live reading on 2026-10-23. Anyone who learns the hostname can read the full glucose and treatment history.
2. **Once a token exists, FitLoop leaks it into logs.** The app passes the Nightscout token/secret to `diabetes-sync` as URL query parameters (`src/app.js:8232-8235`, again at `8262-8265`):

   ```js
   if (profile.diabetes_ns_token)  qs.set('token', profile.diabetes_ns_token);
   if (profile.diabetes_ns_secret) qs.set('secret', profile.diabetes_ns_secret);
   const res = await fetch(`${FUNCTIONS_ORIGIN}/diabetes-sync?${qs.toString()}`, { headers: FUNCTIONS_ANON_HEADERS });
   ```
   Supabase's edge logs record the full request URL (`request.search` is visible in `function_edge_logs`), so the token would be stored in logs on every sync.

## Part A — Nightscout (on the Pi, `lewyc@192.168.1.216`, stack in `~/nightscout-stack`)

1. Back up the env first: `cp <nightscout env file> <same>.bak-$(date +%F)`. (Find the file: `systemctl cat nightscout` shows the `EnvironmentFile`/working dir.)
2. Set `AUTH_DEFAULT_ROLES=denied` (keep `API_SECRET` as is).
3. Restart: `sudo systemctl restart nightscout`, then confirm `curl -s -o /dev/null -w '%{http_code}' https://lewyns.duckdns.org/api/v1/entries.json?count=1` → `401`.
4. In Nightscout's Admin Tools → Subjects, create a subject `fitloop` with role `readable` and copy its access token.
5. Confirm uploaders still work: `nightscout-connect` and `tconnectsync` authenticate with `API_SECRET`, so they should be unaffected — check `journalctl -u nightscout-connect -n 20` and `-u tconnectsync -n 20` show successful uploads after the restart, and a new reading appears within ~10 min.
6. Check other readers: the Trio/Nightscout iPhone app, Sugarmate-style followers, Uptime Kuma checks against the API. Each needs the token (or a `readable` token of its own). Uptime Kuma: point it at `/api/v1/status.json` (still public with `denied`? — verify; if not, add `?token=`).

## Part B — FitLoop sends the token in a header

1. `src/app.js` (both call sites above): stop putting `token`/`secret` in `qs`; send them as headers instead:

   ```js
   const nsHeaders = { ...FUNCTIONS_ANON_HEADERS };
   if (profile.diabetes_ns_token)  nsHeaders['X-NS-Token']  = profile.diabetes_ns_token;
   if (profile.diabetes_ns_secret) nsHeaders['X-NS-Secret'] = profile.diabetes_ns_secret;
   const res = await fetch(`${FUNCTIONS_ORIGIN}/diabetes-sync?${qs.toString()}`, { headers: nsHeaders });
   ```
2. `supabase/functions/diabetes-sync/index.ts`:
   - add `X-NS-Token, X-NS-Secret` to `Access-Control-Allow-Headers` in `HEADERS`;
   - read `req.headers.get('x-ns-token') ?? qs.get('token')` and `req.headers.get('x-ns-secret') ?? qs.get('secret')` (query fallback keeps old app builds working until everyone updates; add a `shortcut:` comment saying to drop the fallback after the next TestFlight build is installed on both phones).
3. Deploy `diabetes-sync` (Supabase CLI: `npx -y supabase@latest functions deploy diabetes-sync --project-ref nxawnkpzjixishcerxcv`; it imports `_shared/nightscout-adapter.js`, which is generated — run `npm run sync:shared` first).
4. Save the token from Part A step 4 in FitLoop → Settings → Nightscout → Token.
5. Nothing to change in `supabase/functions/_shared/nightscout-fetch.ts` (used by `notify-glucose-forecast`): it already reads the token from the profile and appends `&token=` to its outbound Nightscout URLs (lines 43-48). Outbound URLs aren't in Supabase's request logs; Caddy on the Pi may log them — check its log config if that matters.

## Done when

- Unauthenticated `entries.json` → 401.
- FitLoop's Diabetes tab loads current glucose.
- `notify-glucose-forecast` cron responses (`net._http_response`) are still 200 and not "Nightscout fetch failed".
- Supabase `function_edge_logs` for `diabetes-sync` show no `token=` / `secret=` in `request.search` after the new app build.

## Scope

- **In:** Nightscout env on the Pi; `src/app.js` two fetch sites; `diabetes-sync/index.ts`; possibly `_shared/nightscout-fetch.ts`.
- **Out:** changing Caddy/duckdns, rotating `API_SECRET` (recommend separately if it was ever shared), the uploaders' config.

## Escape hatches

- If after step A3 readings stop arriving (A5 fails), revert the env from the `.bak` file, restart, and report — don't debug the uploaders blind.
- If `profiles.diabetes_ns_token` is also used by something else (grep the repo), list it before changing anything.
