-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-06-24.
-- Apple StoreKit 2 in-app purchase ledger. Written only by api/activate-iap.js
-- (service_role) after a JWS is cryptographically verified against Apple's
-- signature. Keyed by Apple's originalTransactionId so a subscription maps to
-- exactly one Emiti user (dedup) and so future App Store Server Notifications V2
-- (renewal/cancel/refund) can update status without another migration.
create table if not exists public.iap_transactions (
  original_transaction_id text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  text not null,
  status      text not null default 'active',   -- active | cancelled | expired | refunded
  environment text not null,                    -- Production | Sandbox
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists iap_transactions_user_id_idx on public.iap_transactions(user_id);

-- Backend-only. Clients (anon/authenticated) get no policy => no access.
-- service_role bypasses RLS; the explicit policy documents intent.
alter table public.iap_transactions enable row level security;

drop policy if exists "iap_transactions: service_role full access" on public.iap_transactions;
create policy "iap_transactions: service_role full access"
  on public.iap_transactions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.iap_transactions is 'Apple IAP ledger. PK = Apple originalTransactionId. Backend/service_role only.';
