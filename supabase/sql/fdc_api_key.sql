-- Applied to production 2026-10-23. The USDA FoodData Central key is kept in
-- Vault as 'fdc_api_key' (value not recorded here) because Edge Function
-- secrets were unavailable; food-search reads it through this
-- service-role-only RPC. An FDC_API_KEY function secret, if ever set, wins.
create or replace function public.get_fdc_api_key()
returns text language sql security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'fdc_api_key' limit 1 $$;
revoke execute on function public.get_fdc_api_key() from public, anon, authenticated;
grant execute on function public.get_fdc_api_key() to service_role;
