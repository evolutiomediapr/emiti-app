-- C1 de Cobros (Stripe Connect / PayPal Connect). PENDIENTE de aplicar a
-- Supabase project gtxxokmrkesyljqodtrr (Emiti Project).
--
-- 1) profiles: columnas de cuentas conectadas. Las escribe SOLO el backend
--    (service_role): un usuario que pudiera apuntar stripe_connect_id a una
--    cuenta ajena desviaría los cobros de sus facturas hacia otra persona.
--    Se protegen con el mismo mecanismo que profiles.plan (ver
--    002_protect_profiles_plan.sql): la función del trigger se amplía para
--    cubrirlas — el trigger existente ya apunta a esta función, no se recrea.

alter table public.profiles
  add column if not exists stripe_connect_id      text,
  add column if not exists stripe_connect_status  text,   -- pending | active | restricted | disconnected
  add column if not exists paypal_merchant_id     text,
  add column if not exists paypal_connect_status  text;

create or replace function public.protect_profile_plan()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and (
       NEW.plan                  is distinct from OLD.plan
    or NEW.stripe_connect_id     is distinct from OLD.stripe_connect_id
    or NEW.stripe_connect_status is distinct from OLD.stripe_connect_status
    or NEW.paypal_merchant_id    is distinct from OLD.paypal_merchant_id
    or NEW.paypal_connect_status is distinct from OLD.paypal_connect_status
  ) then
    raise exception 'protected columns can only be changed by the billing system'
      using errcode = '42501';  -- insufficient_privilege -> PostgREST devuelve HTTP 403
  end if;
  return NEW;
end;
$$;

-- 2) invoices.user_id como columna real (hoy vive solo dentro del JSON `data`).
--    api/pay-invoice.js la necesita para resolver al dueño de la factura y su
--    cuenta conectada sin parsear JSON (C2). El default server-side hace que
--    los INSERT del cliente autenticado la rellenen solos, sin cambiar el
--    payload del front.

alter table public.invoices
  add column if not exists user_id uuid references auth.users(id);

alter table public.invoices
  alter column user_id set default auth.uid();

-- Backfill fila a fila, tolerante a JSON corrupto: una fila mala no aborta
-- la migración, solo queda con user_id null (se reporta con NOTICE).
do $$
declare r record;
begin
  for r in select id, data from public.invoices where user_id is null loop
    begin
      update public.invoices
         set user_id = nullif((r.data::jsonb #>> '{inv,userId}'), '')::uuid
       where id = r.id;
    exception when others then
      raise notice 'invoices.id=% sin userId recuperable (%)', r.id, sqlerrm;
    end;
  end loop;
end $$;

create index if not exists invoices_user_id_idx on public.invoices(user_id);
