-- Every sleep session per day (night, nap, doze). health_daily.sleep_* keeps
-- the night only. Applied to production 2026-11-17.
create table if not exists public.sleep_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  wake_date   date not null,
  kind        text not null check (kind in ('night','nap','doze')),
  source      text not null check (source in ('healthkit','manual')),
  asleep_hrs  numeric not null,
  deep_hrs    numeric,
  rem_hrs     numeric,
  core_hrs    numeric,
  flag        text,
  received_at timestamptz not null default now(),
  unique (user_id, source, start_at)
);
create index if not exists sleep_sessions_user_wake on public.sleep_sessions (user_id, wake_date);

alter table public.sleep_sessions enable row level security;
create policy "select own sleep_sessions" on public.sleep_sessions for select using (auth.uid() = user_id);
create policy "insert own sleep_sessions" on public.sleep_sessions for insert with check (auth.uid() = user_id);
create policy "update own sleep_sessions" on public.sleep_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own sleep_sessions" on public.sleep_sessions for delete using (auth.uid() = user_id);
