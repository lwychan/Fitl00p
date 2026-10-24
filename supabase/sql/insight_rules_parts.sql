-- Briefing parts on insight rules (applied 2026-10-24 as migration insight_rules_parts).
alter table public.insight_rules
  add column if not exists headline text,
  add column if not exists reason text,
  add column if not exists action text,
  add column if not exists slot text not null default 'app' check (slot in ('app','morning','evening','both'));
