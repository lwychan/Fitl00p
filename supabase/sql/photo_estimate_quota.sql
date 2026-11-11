-- Daily Neuron ledger for the Workers AI food-photo estimator.
-- Cloudflare's free allowance (10,000 Neurons/day) is shared by the whole
-- account, so this is one row per UTC day, not per user. Written only by
-- the food-photo-estimate Edge Function (service role); RLS on with no
-- policies, so the app can't read or write it directly.
create table if not exists public.workers_ai_daily_usage (
  day      date primary key,
  neurons  numeric not null default 0,
  requests integer not null default 0
);
alter table public.workers_ai_daily_usage enable row level security;

-- Adds one call's Neurons atomically and returns the day's new total.
create or replace function public.add_workers_ai_neurons(p_day date, p_neurons numeric)
returns numeric
language sql
security definer
set search_path = public
as $$
  insert into public.workers_ai_daily_usage (day, neurons, requests)
  values (p_day, p_neurons, 1)
  on conflict (day) do update
    set neurons = public.workers_ai_daily_usage.neurons + excluded.neurons,
        requests = public.workers_ai_daily_usage.requests + 1
  returning neurons;
$$;

revoke all on function public.add_workers_ai_neurons(date, numeric) from public, anon, authenticated;
grant execute on function public.add_workers_ai_neurons(date, numeric) to service_role;
