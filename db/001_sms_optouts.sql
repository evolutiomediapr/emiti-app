-- Applied to Supabase project gtxxokmrkesyljqodtrr (Emiti Project) on 2026-06-24.
-- Tracks SMS opt-out state per client phone number (last 10 digits).
-- Written by api/sms-webhook.js when a recipient texts STOP/START.
-- Read by api/cron-reminders.js to skip opted-out numbers.
create table if not exists public.sms_optouts (
  phone text primary key,
  opted_out boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Only the service role (used by the serverless API routes) may access this table.
alter table public.sms_optouts enable row level security;

comment on table public.sms_optouts is 'A2P 10DLC opt-out registry. phone = last 10 digits of the recipient number.';
