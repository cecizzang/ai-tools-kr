-- ai-tools-kr: monetization + usage tracking schema
-- Run this in the Supabase SQL editor (or via `supabase db push` if using the CLI).

-- ============================================================
-- 1. profiles — optional, linked 1:1 to Supabase Auth users.
--    Payments do NOT require a profile (anonymous checkout is allowed),
--    but logging in lets a user see their own payment history.
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: user can read own row"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: user can update own row"
  on public.profiles for update
  using (auth.uid() = id);

-- ============================================================
-- 2. products — plan/price catalog mirrored from Stripe.
--    Keep this in sync manually or via a Stripe webhook
--    (price.created / product.updated events).
-- ============================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  stripe_price_id text not null unique,
  name text not null,
  description text,
  amount integer not null,              -- in smallest currency unit (e.g. cents/won)
  currency text not null default 'krw',
  type text not null check (type in ('one_time', 'subscription')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.products enable row level security;

create policy "products: anyone can read active products"
  on public.products for select
  using (active = true);

-- ============================================================
-- 3. payments — one row per completed Stripe payment
--    (Checkout Session / PaymentIntent). Written ONLY by the
--    webhook handler using the service_role key, which bypasses RLS.
-- ============================================================
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,   -- nullable: anonymous donations allowed
  product_id uuid references public.products(id),
  stripe_customer_id text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  amount integer not null,              -- actual amount charged, smallest currency unit
  currency text not null default 'krw',
  status text not null check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  customer_email text,                  -- captured from Stripe even when user_id is null
  created_at timestamptz not null default now()
);

create index if not exists payments_user_id_idx on public.payments(user_id);
create index if not exists payments_status_idx on public.payments(status);
create index if not exists payments_created_at_idx on public.payments(created_at desc);

alter table public.payments enable row level security;

create policy "payments: user can read own payments"
  on public.payments for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies for anon/authenticated roles on purpose:
-- only the service_role key (used by the Stripe webhook handler) can write here.

-- ============================================================
-- 4. subscriptions — only needed if you add a recurring plan later.
--    Safe to keep even if unused right now.
-- ============================================================
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  product_id uuid references public.products(id),
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);

alter table public.subscriptions enable row level security;

create policy "subscriptions: user can read own subscriptions"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- ============================================================
-- 5. usage_logs — real traffic evidence (separate from revenue).
--    Insert-only from the client/API; no PII, just event counts.
-- ============================================================
create table if not exists public.usage_logs (
  id bigint generated always as identity primary key,
  event_type text not null,             -- e.g. 'fetch_company'
  company_id text,                      -- e.g. 'anthropic', nullable for non-company events
  session_id text,                      -- random client-generated id, NOT tied to identity
  created_at timestamptz not null default now()
);

create index if not exists usage_logs_created_at_idx on public.usage_logs(created_at desc);
create index if not exists usage_logs_event_type_idx on public.usage_logs(event_type);

alter table public.usage_logs enable row level security;

create policy "usage_logs: anyone can insert"
  on public.usage_logs for insert
  with check (true);

-- Deliberately no select policy for anon/authenticated: raw logs stay private,
-- aggregates are exposed only through get_usage_stats() below.

-- ============================================================
-- 6. Public aggregate stats — safe to expose on the homepage
--    without leaking individual payments or logs.
-- ============================================================
create or replace function public.get_donation_stats()
returns table (total_amount bigint, total_count bigint, currency text)
language sql
security definer
set search_path = public
as $$
  select
    coalesce(sum(amount), 0)::bigint as total_amount,
    count(*)::bigint as total_count,
    coalesce(min(currency), 'krw') as currency
  from public.payments
  where status = 'succeeded';
$$;

grant execute on function public.get_donation_stats() to anon, authenticated;

create or replace function public.get_usage_stats()
returns table (total_events bigint, last_7_days bigint)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::bigint as total_events,
    count(*) filter (where created_at > now() - interval '7 days')::bigint as last_7_days
  from public.usage_logs;
$$;

grant execute on function public.get_usage_stats() to anon, authenticated;

-- ============================================================
-- 7. Base table grants — required in addition to RLS policies.
--    RLS only filters ROWS; without these GRANTs the anon/authenticated
--    roles get "permission denied" before RLS is even evaluated.
--    (The Supabase Table Editor UI adds these automatically; raw SQL does not.)
-- ============================================================
grant usage on schema public to anon, authenticated;

grant insert on public.usage_logs to anon, authenticated;
grant select on public.products to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.payments to authenticated;
grant select on public.subscriptions to authenticated;

-- ============================================================
-- 8. company_updates — daily cron-refreshed AI company summaries.
--    Written ONLY by the daily Vercel Cron job using the
--    service_role key, which bypasses RLS. Visitors only ever read.
-- ============================================================
create table if not exists public.company_updates (
  id uuid primary key default gen_random_uuid(),
  company_id text not null unique,
  company_name text not null,
  summary text not null,
  fetched_at timestamptz not null default now()
);

alter table public.company_updates enable row level security;

create policy "company_updates: anyone can read"
  on public.company_updates for select
  using (true);

grant select on public.company_updates to anon, authenticated;

-- No insert/update/delete policies or grants for anon/authenticated on purpose:
-- only the service_role key (used by the cron handler) can write here.
grant select, insert, update on public.company_updates to service_role;

