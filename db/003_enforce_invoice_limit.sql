-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-06-24.
-- Server-side, bypass-proof enforcement of the free-plan monthly document limit
-- (3 invoices + 3 quotes per month). Replaces the client-only fpr4_usage counter,
-- which was trivially bypassable by clearing localStorage, and also closes the
-- direct-insert bypass (the invoices INSERT RLS policy has no count check).
--
-- Fires on every invoices INSERT from end-user (PostgREST) sessions and delegates
-- to the pre-existing check_limit_and_increment RPC (Pro exemption, lazy monthly
-- reset, per-type counters, atomic increment). Runs in the INSERT's transaction,
-- so a failed/rolled-back insert does not consume a slot.
--
-- IMPORTANT: the role guard uses auth.role() (the JWT role claim), NOT current_user.
-- Because this function is SECURITY DEFINER, current_user would be the owner
-- (postgres) inside it and would wrongly exempt every end-user session.
create or replace function public.enforce_invoice_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_type   text;
  v_result jsonb;
begin
  -- Only enforce for end-user sessions. service_role/admin (backend, cron,
  -- migrations, support) are exempt.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return NEW;
  end if;

  -- Map the document type to the RPC's expected values ('invoice' | 'quote').
  v_type := case when NEW.type = 'invoice' then 'invoice' else 'quote' end;

  -- Reuse the existing check-and-increment logic (atomic in this transaction).
  v_result := public.check_limit_and_increment(v_uid, v_type);

  if coalesce((v_result->>'allowed')::boolean, false) = false then
    raise exception 'monthly_limit_reached: %', coalesce(v_result->>'reason', 'limit')
      using errcode = '42501';  -- insufficient_privilege -> PostgREST HTTP 403
  end if;

  return NEW;
end;
$$;

drop trigger if exists enforce_invoice_limit on public.invoices;
create trigger enforce_invoice_limit
before insert on public.invoices
for each row
execute function public.enforce_invoice_limit();
