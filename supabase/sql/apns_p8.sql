-- Applied to production 2026-10-24. The APNs .p8 private key (Apple key
-- 562J9DG675, "FitLoop APNs") is kept in Vault as 'apns_p8' (value not
-- recorded here; added by the account owner) because Edge Function secrets
-- were unavailable ("Storing keys is paused"). _shared/webpush.ts reads it
-- through this service-role-only RPC; an APNS_P8 function secret, if ever
-- set, wins.
create or replace function public.get_apns_p8()
returns text language sql security definer set search_path = ''
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'apns_p8' limit 1 $$;
revoke execute on function public.get_apns_p8() from public, anon, authenticated;
grant execute on function public.get_apns_p8() to service_role;
