-- Latest Body Battery / strain per user per day, saved by the app on every
-- Body Battery recompute (latest wins). The evening briefing and the morning
-- sleep-data fallback read it (applied 2026-10-24 as migration readiness_snapshots).
create table if not exists public.readiness_snapshots (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  snap_date date not null,
  taken_at timestamptz not null default now(),
  battery smallint,
  strain numeric,
  battery_parts jsonb,
  primary key (user_id, snap_date)
);
alter table public.readiness_snapshots enable row level security;
drop policy if exists "own snapshots" on public.readiness_snapshots;
create policy "own snapshots" on public.readiness_snapshots for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.readiness_snapshots to authenticated;
