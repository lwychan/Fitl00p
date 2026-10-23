# 005 — Run the tests (and shared-copy check) before every TestFlight build

- **Written against:** `aa381de` (branch `audit-fixes`).
- **Category:** DX / tooling · **Impact:** Medium · **Effort:** S · **Risk of fix:** Low

## Why

`npm test` now exists (`package.json`): it runs `tests/*.test.js` (diabetes dose maths) and `scripts/sync-shared.mjs --check`, which fails if the generated server copies under `supabase/functions/_shared/*.js` have drifted from `src/`. Nothing runs it automatically: `codemagic.yaml` goes straight from `npm ci` to `npx cap sync ios` to a signed build uploaded to TestFlight. A dose-maths regression would reach both phones without anyone seeing a failure.

Current steps (`codemagic.yaml:69-74`):

```yaml
    scripts:
      - name: Install npm dependencies
        script: npm ci

      - name: Sync Capacitor (copies src/ into the iOS project, updates Package.swift)
        script: npx cap sync ios
```

## Steps

1. Insert a step between those two, matching the file's existing indentation and naming style:

   ```yaml
      - name: Run tests (dose maths + shared-copy check)
        script: npm test
   ```
2. Check that the YAML still parses: `node -e "require('fs').readFileSync('codemagic.yaml','utf8')"` only proves the file reads, so also run `npx -y js-yaml codemagic.yaml > /dev/null` and expect exit 0.
3. Check that `npm test` passes locally on the same commit before pushing.

## Scope

- **In:** `codemagic.yaml`.
- **Out:** adding a GitHub Actions workflow, linting, or type-checking the Edge Functions in CI (possible later: the type-check recipe used during the 2026-10-23 audit needed a `Deno` shim and a temporary tsconfig).

## Done when

- `codemagic.yaml` has the new step, between `npm ci` and `cap sync`.
- The next Codemagic build log shows "Run tests" passing before signing starts.

## Maintenance

When you add tests, keep them `node:test` with no extra dependencies, so `npm ci` stays the only install step.

## Escape hatches

- If Codemagic's Node version can't run `node --test` with a glob (Node < 21), stop and report the version shown in the build log rather than rewriting the test command.
