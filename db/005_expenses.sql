-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-07-05.
-- Feature "Gastos" (Pro-only), Fase G1: tabla de gastos con RLS por dueño.
--
-- Patrón "services" (Supabase-directo, sin copia local): columnas tipadas
-- porque los reportes filtran/suman por fecha y categoría. receipt_path se
-- llena en G2 (bucket privado expense-receipts) — nullable desde el día 1.
-- Gate Pro server-side SOLO en INSERT: la policy exige profiles.plan='pro'
-- (el EXISTS corre con los privilegios del usuario y funciona porque la
-- policy "profiles: select own" le permite leer su propia fila). SELECT/
-- UPDATE/DELETE quedan owner-only sin check de plan: un ex-Pro conserva la
-- lectura de sus gastos (modo lectura; el cliente bloquea editar/borrar).
-- El endpoint de escaneo IA (G4) hará su propio check de plan con service role.
--
-- El borrado de cuenta (RPC delete_user) elimina auth.users → el FK con
-- on delete cascade limpia expenses sin tocar la RPC.

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant text not null,
  date date not null default current_date,
  total numeric(12,2) not null check (total >= 0),
  tax numeric(12,2) check (tax >= 0),
  category text not null default 'Otros',
  receipt_path text,
  notes text,
  created_at timestamptz not null default now()
);

-- Listados y sumas mensuales siempre son "mis gastos por fecha desc"
create index if not exists expenses_user_date_idx on public.expenses (user_id, date desc);

alter table public.expenses enable row level security;

create policy "expenses: select own" on public.expenses
  for select using (auth.uid() = user_id);
create policy "expenses: insert own pro" on public.expenses
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and plan = 'pro'
    )
  );
create policy "expenses: update own" on public.expenses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "expenses: delete own" on public.expenses
  for delete using (auth.uid() = user_id);

comment on table public.expenses is 'Gastos del negocio (feature Pro). receipt_path apunta al bucket privado expense-receipts (G2).';
