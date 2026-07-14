-- 009: Onboarding guiado — profiles.onboarded_at
-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-07-13.
--
-- Marca cuándo el usuario completó (o saltó) el wizard de primer documento.
-- NULL = nunca lo vio → el frontend lo dispara en el primer arranque con
-- sesión real. El backfill marca a TODOS los usuarios existentes como
-- onboarded para que el wizard solo aplique a cuentas nuevas.
--
-- El cliente actualiza su propia fila vía la política RLS "profiles: update
-- own" ya existente; el trigger protect_profile_plan (002) solo protege
-- `plan`, así que esta columna no necesita permisos nuevos.

alter table public.profiles add column if not exists onboarded_at timestamptz;

update public.profiles set onboarded_at = now() where onboarded_at is null;
