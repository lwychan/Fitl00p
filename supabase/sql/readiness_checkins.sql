-- Morning "how do you feel" check-in (1-5), used to personalise the
-- Recovery score's weights (src/readiness-model.js fitRecoveryWeights).
-- The app saves the fitted weights to profiles.recovery_weights so the
-- notify-* functions (via _shared/health-scores.ts) score Recovery the same
-- way the dashboard does. Applied 2026-10-24.

create table if not exists public.readiness_checkins (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  log_date   date        not null,
  feel       smallint    not null check (feel between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

alter table public.readiness_checkins enable row level security;

create policy "readiness_checkins own rows" on public.readiness_checkins
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.readiness_checkins to authenticated;

-- { hrv, rhr, rr, sleep } summing to 1, plus n/blend/agreement for display.
alter table public.profiles add column if not exists recovery_weights jsonb;
-- profiles UPDATE is granted per column (see audit_2026_10_23.sql).
grant update (recovery_weights) on public.profiles to authenticated;
