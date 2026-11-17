-- Applied to production 2026-11-17. The shared-catalogue SELECT policy only
-- allowed role = 'approved', so an admin's insert of a custom food failed on
-- its returned row (403) and "Your foods" search came back empty.
create policy "select own custom_foods" on public.custom_foods
  for select using (auth.uid() = user_id);
