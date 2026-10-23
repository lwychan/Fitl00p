-- Applied to production 2026-10-23 via the Supabase MCP (plans/004 step 5).
-- Saved meals for the Food tab: a named group of food items re-added to any
-- diary section in one tap. Replaces favorite_meals in the UI; the old table
-- and its rows are left in place (19 rows copied in below at creation).

create table public.saved_meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  -- [{food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, custom_food_id, barcode, source}]
  -- macros are the logged totals (quantity already applied), as in food_log
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  created_at timestamptz not null default now()
);
create index saved_meals_user on public.saved_meals (user_id, created_at desc);
alter table public.saved_meals enable row level security;
create policy "own saved_meals" on public.saved_meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into public.saved_meals (user_id, name, items, created_at)
select user_id, name,
  jsonb_build_array(jsonb_build_object(
    'food_name', name, 'brand', brand, 'serving_desc', serving_desc, 'quantity', 1,
    'calories_kcal', calories_kcal, 'protein_g', protein_g, 'carbs_g', carbs_g, 'fat_g', fat_g,
    'barcode', barcode, 'custom_food_id', null, 'source', 'manual')),
  created_at
from public.favorite_meals;
