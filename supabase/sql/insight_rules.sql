-- Rule-based insights (replaces the AI coach briefing — no live AI). Rows are
-- shared by everyone; the app evaluates them (src/insights.js) against each
-- person's own numbers. Source of truth: supabase/seed/insight-rules.json ->
-- scripts/build-insight-rules.mjs -> insight_rules_seed.sql. Applied 2026-10-24.
create table if not exists public.insight_rules (
  id          text primary key,
  category    text not null,
  severity    text not null check (severity in ('good', 'info', 'caution', 'warn')),
  priority    int  not null default 50,
  conditions  jsonb not null,
  title       text not null,
  body        text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.insight_rules enable row level security;

-- Read-only for signed-in users; edited only via SQL / the seed script.
create policy "insight_rules readable" on public.insight_rules
  for select to authenticated using (true);

grant select on public.insight_rules to authenticated;
