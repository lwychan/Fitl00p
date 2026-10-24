# Diabetes engine v1 (archived)

The diabetes engine as it was before the learning change. Kept out of the build: nothing loads these files (not `src/index.html`, not `sync-shared.mjs`, not the `npm test` glob `tests/*.test.js`).

- `diabetes-engine.js` — byte-for-byte copy of `src/diabetes-engine.js` at tag `diabetes-engine-v1`.
- `diabetes-engine.test.js` — copy of `tests/diabetes-engine.test.js`, require path set to `./diabetes-engine.js`.

## Revert

```
node scripts/revert-diabetes-engine.mjs --check   # verify the archive still passes (changes nothing)
node scripts/revert-diabetes-engine.mjs           # copy v1 back over src/ and tests/, sync shared copies, npm test
```

The real revert prints the Supabase functions to redeploy afterwards. Tag `diabetes-engine-v1` marks the commit that archived this copy.
