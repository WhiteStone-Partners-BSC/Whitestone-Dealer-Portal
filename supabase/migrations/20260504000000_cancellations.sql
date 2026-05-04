-- Run in Supabase SQL editor (or via CLI) before deploying portal changes.
-- Cancellations workflow + contract pricing columns.

create table if not exists public.cancellations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  contract_id uuid references public.contracts (id) on delete set null,
  dealer_id uuid,
  customer_name text,
  dealership_name text,
  contract_type text,
  retail_price numeric,
  wholesale_price numeric,
  dealer_margin numeric,
  contract_start_date date,
  days_elapsed integer,
  days_remaining integer,
  total_contract_days integer,
  grace_period_applies boolean,
  services_used_value numeric,
  customer_refund_amount numeric,
  whitestone_refund_amount numeric,
  dealer_refund_amount numeric,
  dealer_fee numeric default 0,
  dealer_fee_waived boolean default false,
  dealer_fee_reason text,
  reason text,
  reason_notes text,
  status text not null default 'pending',
  notes text,
  admin_notes text,
  approved_by text,
  approved_at timestamptz
);

create index if not exists cancellations_contract_id_idx on public.cancellations (contract_id);
create index if not exists cancellations_status_idx on public.cancellations (status);
create index if not exists cancellations_created_at_idx on public.cancellations (created_at desc);

alter table public.contracts add column if not exists wholesale_price numeric;
alter table public.contracts add column if not exists stripe_charge_amount numeric;
alter table public.contracts add column if not exists cancelled_at timestamptz;
alter table public.contracts add column if not exists cancellation_id uuid references public.cancellations (id) on delete set null;

comment on table public.cancellations is 'Dealer-initiated cancellation requests; estimates stored for admin review.';
comment on column public.contracts.wholesale_price is 'Amount dealer paid Whitestone for this contract tier when known.';
comment on column public.contracts.stripe_charge_amount is 'USD amount from Stripe PaymentIntent when available.';
