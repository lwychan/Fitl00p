-- Diabetes learning (Task 8): episode store + learned model history, written
-- only by the nightly diabetes-learn Edge Function (service role). Clients can
-- read their own rows; there are no client write policies.
-- Tables/RLS applied to production 2026-10-26 (MCP apply_migration
-- 'dx_learning'); cron scheduled 2026-11-05 after the forced first run.

create table if not exists public.dx_episodes (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('correction', 'meal', 'exercise', 'night')),
  start_at timestamptz not null,
  episode jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, start_at)
);

create table if not exists public.dx_model (
  user_id uuid not null references auth.users on delete cascade,
  fitted_at timestamptz not null,
  model jsonb not null,
  episodes_used int,
  primary key (user_id, fitted_at)
);

alter table public.dx_episodes enable row level security;
alter table public.dx_model enable row level security;

drop policy if exists "dx_episodes select own" on public.dx_episodes;
create policy "dx_episodes select own" on public.dx_episodes
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "dx_model select own" on public.dx_model;
create policy "dx_model select own" on public.dx_model
  for select to authenticated using ((select auth.uid()) = user_id);

-- Everything but SELECT revoked (TRUNCATE bypasses RLS, so revoking only
-- insert/update/delete wasn't enough). Applied 2026-11-05 as migration
-- 'dx_learning_grants'; verified via information_schema.role_table_grants:
-- authenticated = SELECT only, anon = none.
revoke all on public.dx_episodes, public.dx_model from anon, authenticated;
grant select on public.dx_episodes, public.dx_model to authenticated;

-- Nightly at 02:30 and 03:30 UTC; the function acts only when it is 03:xx in
-- London (03:30 BST / 03:30 GMT), so it runs once a night across DST.
-- Manual / first run: ?force=1 bypasses the hour guard (invoke_edge_fn just
-- appends its argument to the functions URL). Each call learns one 10-day
-- backfill chunk until model.learn.backfillComplete, so repeat it one at a
-- time (wait for the previous net._http_response row) until that is true:
--   select private.invoke_edge_fn('diabetes-learn?force=1');
-- First run 2026-11-05: 10 calls (Nightscout data starts 2026-09-09).
select cron.unschedule('diabetes-learn') where exists (select 1 from cron.job where jobname = 'diabetes-learn');
select cron.schedule('diabetes-learn', '30 2,3 * * *', $$select private.invoke_edge_fn('diabetes-learn')$$);

-- Nightly settings review (applied 2026-11-06): 03:45 London, after diabetes-learn.
select cron.unschedule('diabetes-review') where exists (select 1 from cron.job where jobname = 'diabetes-review');
select cron.schedule('diabetes-review', '45 2,3 * * *', $$select private.invoke_edge_fn('diabetes-review')$$);
