# 001 — Escape untrusted text before it reaches innerHTML

- **Written against:** `aa381de` (branch `audit-fixes`). If `git log aa381de..HEAD -- src/app.js` shows changes, re-check every line number below before editing.
- **Category:** security · **Impact:** High · **Effort:** S · **Risk of fix:** Low

## Why

`src/app.js` builds most UI with template strings assigned to `innerHTML` (128 sites) and there is no Content-Security-Policy in `src/index.html`. Some templates interpolate text that other people control without passing it through the existing `escapeHtml()` helper.

The worst one is the admin approval list. **Any signed-in account** (including a brand-new, still-pending sign-up) can write its own `approval_requests` row with any `name`/`email` — the RLS insert policy is just `with_check (auth.uid() = user_id)`. That row is rendered unescaped in the admin panel, so a sign-up named `<img src=x onerror="…">` runs script in the admin's (Lewis's) session the next time he opens the approval list — with his JWT, so it can approve itself via `admin-approve`, read every table admins can read, etc.

Current code (`src/app.js:11915-11926`):

```js
  function userRow(r, actions) {
    const initials = (r.name || r.email || '?').charAt(0).toUpperCase();
    const date = r.requested_at ? new Date(r.requested_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';
    return `<div class="iam-user-row" data-uid="${r.user_id}">
      <div class="iam-user-avatar">${initials}</div>
      <div class="iam-user-info">
        <div class="iam-user-name">${r.name || '—'}</div>
        <div class="iam-user-email">${r.email}</div>
```

## Repo conventions

- The helper already exists and escapes `& < > " '`, so it is safe in text **and** in quoted attributes (`src/app.js:723`):

  ```js
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  ```
- Exemplar of correct use (`src/app.js`, `lfSearchResultButton`):

  ```js
  <span class="lf-search-result__name">${escapeHtml(f.name)}${f.brand ? ` <span class="lf-search-result__brand">${escapeHtml(f.brand)}</span>` : ''}</span>
  ```
- Plain vanilla JS, no framework, no build step. Do not introduce a templating library.

## Steps

1. **Admin approval list** — `src/app.js:11916-11922`: wrap `r.name`, `r.email` and the computed `initials` in `escapeHtml(...)`. Also wrap `r.user_id` in the `data-uid` attributes of `userRow` and the approve/reject buttons (lines ~11918, 11931-11932).
   Verify: `grep -n 'iam-user-name\|iam-user-email' src/app.js` → both lines contain `escapeHtml(`.
2. **Exercise / routine names and notes** (household-editable or third-party via ExerciseDB) — wrap in `escapeHtml(...)` at each of these (line numbers at `aa381de`):
   - `4458` `${r.name}` · `4466` `${r.description}`
   - `4596`, `4626`, `4726` `${ex.name}` / `${opt.name}` text; `4625`, `4725` `data-name="${opt.name}"`; `4691` `${ex.name}`
   - `5100-5103` `alt="${ex.name} demonstration"` and `${ex.media.matched_name}`
   - `5244`, `5285`, `5309` `${ex.name}` · `5257` `${ex.notes}` · `5359` `${activeRoutine.name}`
   - `5711-5713` `alt="${ex.name}"` and `${data.name}` (comes from the ExerciseDB API)
   - `6047` `${r.name}`
   - `11698` `${r.name}` · `11735` `value="${ex.name}"` · `11742` `value="${ex.notes || ''}"`
   Do **not** change the `confirm(...)` strings at 4288, 4833, 5450 — `confirm()` renders plain text.
3. **Error messages put into HTML** — `10769` `${error.message}` and `13772` `${err.message}`: wrap in `escapeHtml`.
4. **GIF URLs in `src` attributes** — `5100` `src="${ex.media.gif_url}"` and `5712` `src="${data.gifUrl}"`: escape *and* only render the `<img>` when the URL starts with `https://static.exercisedb.dev/` (every one of the 32 stored URLs does today). Add a tiny helper next to `escapeHtml`:

   ```js
   // ExerciseDB is the only GIF source; anything else in exercise_media is not rendered.
   const safeGifUrl = u => (typeof u === 'string' && u.startsWith('https://static.exercisedb.dev/')) ? escapeHtml(u) : null;
   ```
   and use `safeGifUrl(...)` in both places, falling back to the existing "No animation found" markup when it returns `null`.
5. Re-run the sweep to catch anything missed:

   ```bash
   grep -nE '\$\{[^}]*\.(name|food_name|title|notes?|meal_name|brand|display_name|description|content|email|serving_desc|exercise_name|message|matched_name|gif_url|gifUrl)\b[^}]*\}' src/app.js | grep -v escapeHtml | grep -vE "textContent|console\.|showToast|confirm\(|\.eq\(|throw new"
   ```
   Expected: only lines that build plain text (no HTML) remain; review each by eye.

## Scope

- **In:** `src/app.js` only.
- **Out:** RLS / database changes (see plan 002), adding a CSP (separate decision — inline styles/scripts in `index.html` would need auditing first), any refactor of rendering.

## Done when

- `node --check src/app.js` exits 0.
- `npm test` passes (unchanged engine tests).
- The step-5 grep shows no HTML-building line with an unescaped user/third-party field.
- Manual check (web build is fine, `src/index.html` opened via any static server): as an admin, an approval request whose `name` is `<b>x</b>` renders the literal text `<b>x</b>`, not bold.

## Test plan

There is no DOM test harness in this repo (only `tests/diabetes-engine.test.js`, `node:test`). Do not add one for this plan; the grep in step 5 plus the manual check is the gate. If you want a regression guard, add `tests/escape-html.test.js` copying the style of `tests/diabetes-engine.test.js`, extracting nothing from `app.js` — just a source-text test that greps `src/app.js` for the patterns in step 5 and fails on new matches.

## Maintenance

Every new template that interpolates a name, note, title or anything from an API must go through `escapeHtml`.

## Escape hatches

- If a line number no longer matches the quoted code, search for the quoted snippet instead; if it's gone, skip it and note it.
- If escaping a value visibly breaks rendering (e.g. a field intentionally contains markup), stop and report — don't remove the escape.
