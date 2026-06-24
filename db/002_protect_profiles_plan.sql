-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-06-24.
-- Security fix: prevent end-users from self-granting Pro.
--
-- Before this, the RLS policy "profiles: update own" let any authenticated user
-- UPDATE their own row including the `plan` column, so anyone could run
--   supa.from('profiles').update({ plan:'pro' }).eq('id', CURRENT_USER.id)
-- from the browser console and become Pro permanently without paying.
--
-- This trigger blocks changes to profiles.plan from PostgREST end-user sessions
-- ('authenticated'/'anon'). The billing backend uses the service_role key
-- (current_user = 'service_role') and direct DB admins (current_user = 'postgres')
-- are unaffected, so api/stripe-webhook.js, api/create-checkout-session.js and a
-- future server-side IAP activation endpoint keep working.
create or replace function public.protect_profile_plan()
returns trigger
language plpgsql
as $$
begin
  if NEW.plan is distinct from OLD.plan
     and current_user in ('authenticated', 'anon') then
    raise exception 'plan can only be changed by the billing system'
      using errcode = '42501';  -- insufficient_privilege -> PostgREST returns HTTP 403
  end if;
  return NEW;
end;
$$;

drop trigger if exists protect_profile_plan on public.profiles;
create trigger protect_profile_plan
before update on public.profiles
for each row
execute function public.protect_profile_plan();
