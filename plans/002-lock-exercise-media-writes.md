# 002 — Stop any signed-in account rewriting exercise_media

- **Written against:** `aa381de` (branch `audit-fixes`).
- **Category:** security · **Impact:** High · **Effort:** S · **Risk of fix:** Low
- **Depends on:** nothing, but pairs with plan 001 step 4 (render-side check).

## Why

`public.exercise_media` (GIF cache + coaching cues for every exercise) has the policy:

```
"Authenticated users can write exercise_media"  FOR ALL  USING (true)  WITH CHECK (true)
```

So any signed-in account — including an unapproved new sign-up — can update or delete every row. `gif_url` is rendered into `<img src="…">` for both household users (`src/app.js:5100`), so a hostile value is stored XSS against Lewis and Gemma; deleting rows wipes the cue/muscle data.

The only client write is the GIF cache fill after an ExerciseDB lookup (`src/app.js:5702`):

```js
      db.from('exercise_media').update({ gif_url: data.gifUrl, exercisedb_id: data.exerciseId })
        .eq('exercise_name', ex.name)
```

Today all 32 stored `gif_url` values are on `https://static.exercisedb.dev/` (checked 2026-10-23), so nothing has been tampered with yet.

## Steps

1. Apply this SQL to the production project (`nxawnkpzjixishcerxcv`) — via the Supabase dashboard SQL editor or the MCP `apply_migration` tool — and save the same text as `supabase/sql/2026xxxx_exercise_media_policies.sql` (repo convention: one-off production SQL is recorded under `supabase/sql/`, see `supabase/sql/audit_2026_10_23.sql`):

   ```sql
   drop policy "Authenticated users can write exercise_media" on public.exercise_media;

   -- Approved household members may fill the GIF cache columns only, and only
   -- with an ExerciseDB URL. Everything else (cues, muscles, new rows) is admin-only.
   create policy "approved users update gif cache" on public.exercise_media
     for update to authenticated
     using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('approved','admin')))
     with check (gif_url is null or gif_url like 'https://static.exercisedb.dev/%');

   create policy "admins manage exercise_media" on public.exercise_media
     for all to authenticated
     using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
     with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

   revoke update on public.exercise_media from authenticated;
   grant update (gif_url, exercisedb_id) on public.exercise_media to authenticated;
   grant insert, delete on public.exercise_media to authenticated; -- still gated to admins by the policy above
   ```
   Checked at `aa381de`: `src/app.js:5702` is the only client write to `exercise_media` (the other eight `from('exercise_media')` calls are selects), so restricting client UPDATE to `gif_url, exercisedb_id` loses nothing. Admin edits to cues/muscles happen in the Supabase dashboard (service role), which grants don't affect.
2. Verify the policies:

   ```sql
   select policyname, cmd from pg_policies where tablename = 'exercise_media';
   ```
   Expected: `Public read exercise_media` (SELECT), `approved users update gif cache` (UPDATE), `admins manage exercise_media` (ALL). The old "Authenticated users can write" row is gone.
3. Check the app still caches GIFs: open a workout as Gemma (approved), expand an exercise with no cached GIF, confirm the GIF shows and no `GIF cache write failed` warning appears in `error_logs`.

## Scope

- **In:** RLS/grants on `public.exercise_media`, a record under `supabase/sql/`.
- **Out:** moving the cache write into the `exercise-media` Edge Function (a bigger change; only do it if step 3 fails), any other table.

## Done when

- The step-2 query matches the expected list.
- As a non-admin, `update exercise_media set key_cues = 'x'` affects 0 rows / is denied; setting `gif_url = 'https://evil.example/x.gif'` is denied.
- GIF caching still works for an approved user (step 3).

## Maintenance

New writable columns on `exercise_media` must be granted explicitly if they need client writes.

## Escape hatches

- If `profiles.role` values differ from `'approved' | 'admin' | 'pending' | 'rejected'`, stop and report.
- If the admin editor breaks after step 1, revert to the previous policy only after reporting what failed.
