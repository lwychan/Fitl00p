-- Applied to production 2026-10-23 via the Supabase MCP (Ponytail audit fixes).

-- #1 Users could self-promote: "Users can update own profile" had no column
-- limit and the table-wide UPDATE grant covered role. Role/approval columns
-- are now writable only by the service key (admin-approve).
-- NOTE: a new profiles column needs `grant update (<col>) on public.profiles
-- to authenticated;` or the app can't edit it.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name not in ('id', 'role', 'approved_by', 'approved_at');
  execute 'revoke update on public.profiles from authenticated, anon';
  execute format('grant update (%s) on public.profiles to authenticated', cols);
end $$;

-- Leftover QA account (fitl00p.qa.test@example.com) demoted; delete it in
-- Auth → Users.
update public.profiles set role = 'rejected' where id = '1838f0ad-4320-40ff-bf21-745e59bc4605';

-- #13 view ran as its owner, bypassing trading_signals RLS for anon.
alter view public.signal_outcomes set (security_invoker = on);

-- AI coach retired.
select cron.unschedule('notify-ai-coach');
