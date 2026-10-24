-- Morning & evening briefings (applied 2026-10-24 as migration briefings;
-- the cron line was run after notify-briefings was deployed).

-- One row per person per briefing/reminder per day. notify-* functions insert
-- BEFORE sending (on conflict do nothing) and only send when the insert
-- landed, so overlapping runs can never double-send. Service role only.
create table if not exists public.briefing_log (
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind ~ '^(morning|evening|meds|peptide_nudge|tirzepatide_nudge_[0-9]+)$'),
  sent_date date not null,
  sent_at timestamptz not null default now(),
  body text,
  primary key (user_id, kind, sent_date)
);
alter table public.briefing_log enable row level security;

-- Per-person briefing times, merged over the defaults in src/briefings.js:
-- { "morning": { "weekday": "05:45", "weekend": "07:30" },
--   "wake":    { "weekday": "05:30", "weekend": "07:30" } }
alter table public.profiles add column if not exists briefing_schedule jsonb;
grant update (briefing_schedule) on public.profiles to authenticated;

select cron.schedule('notify-briefings', '*/15 * * * *', $$select private.invoke_edge_fn('notify-briefings')$$);
