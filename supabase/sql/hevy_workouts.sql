-- Hevy workout summaries, pulled by the hevy-sync Edge Function (pg_cron,
-- every 15 min). Summary only — no per-set rows; Hevy stays the source of
-- truth for set detail. Applied via the Supabase MCP (this repo has no
-- migrations directory); kept here as the record of what was run.

create table if not exists public.hevy_workouts (
  id              text primary key,             -- Hevy workout id
  user_id         uuid not null references auth.users on delete cascade,
  title           text,
  routine_id      text,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  duration_min    int,
  exercise_count  int,
  set_count       int,                           -- working sets (warm-ups excluded)
  volume_kg       numeric,                       -- sum of weight_kg × reps, working sets
  exercises       jsonb,                         -- [{ title, sets }] for the card
  hevy_updated_at timestamptz,
  synced_at       timestamptz not null default now()
);
create index if not exists hevy_workouts_user_started on public.hevy_workouts (user_id, started_at desc);

alter table public.hevy_workouts enable row level security;
create policy "hevy_workouts: read own" on public.hevy_workouts
  for select using (auth.uid() = user_id);

-- Cursor for /v1/workouts/events?since= — one row per linked user.
create table if not exists public.hevy_sync_state (
  user_id        uuid primary key references auth.users on delete cascade,
  last_synced_at timestamptz not null
);
alter table public.hevy_sync_state enable row level security; -- service role only

-- Schedule (run after deploying hevy-sync):
-- select cron.schedule('hevy-sync', '*/15 * * * *', $$select private.invoke_edge_fn('hevy-sync')$$);

-- Applied 2026-09-29. API key stored in Vault as 'hevy_api_key' (value not
-- recorded here), read by hevy-sync through this service-role-only RPC:
create or replace function public.get_hevy_api_key()
returns text language sql security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'hevy_api_key' limit 1 $$;
revoke execute on function public.get_hevy_api_key() from public, anon, authenticated;
grant execute on function public.get_hevy_api_key() to service_role;
-- Cron scheduled 2026-09-29 (job 'hevy-sync', */15).
