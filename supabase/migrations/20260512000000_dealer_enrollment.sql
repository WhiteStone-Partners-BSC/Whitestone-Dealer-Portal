-- Dealer participation agreement enrollment (admin) — additional columns on dealers
-- Idempotent: safe to re-run. Complements 20260511120000_dealer_enrollment_columns.sql.

alter table public.dealers add column if not exists dba text;
alter table public.dealers add column if not exists ein text;
alter table public.dealers add column if not exists dealer_number text;
alter table public.dealers add column if not exists brands_carried text;

-- Authorized contacts: store as JSONB array of {name, position} objects, max 10
alter table public.dealers add column if not exists authorized_contacts jsonb default '[]'::jsonb;

-- Accounting block
alter table public.dealers add column if not exists ar_contact_name text;
alter table public.dealers add column if not exists ar_phone text;
alter table public.dealers add column if not exists ar_email text;
alter table public.dealers add column if not exists bank_account_number text;
alter table public.dealers add column if not exists bank_routing_number text;

-- Enrollment lifecycle
alter table public.dealers add column if not exists enrollment_status text default 'not_started'
    check (enrollment_status in ('not_started', 'submitted', 'signed', 'active'));
alter table public.dealers add column if not exists enrollment_submitted_at timestamptz;
alter table public.dealers add column if not exists enrollment_effective_date date;
alter table public.dealers add column if not exists agreement_signed_at timestamptz;
alter table public.dealers add column if not exists agreement_signed_by text;

create index if not exists dealers_enrollment_status_idx on public.dealers(enrollment_status);

-- Legacy dealers (already active before enrollment tracking): allow pricing without re-enrollment.
update public.dealers
set enrollment_status = 'active'
where coalesce(is_admin, false) = false
  and coalesce(active, false) = true
  and enrollment_submitted_at is null
  and coalesce(enrollment_status, 'not_started') = 'not_started';
