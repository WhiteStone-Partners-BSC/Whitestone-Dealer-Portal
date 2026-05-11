-- Dealer enrollment form (admin portal) — additional columns on dealers
alter table public.dealers add column if not exists legal_business_name text;
alter table public.dealers add column if not exists dba_name text;
alter table public.dealers add column if not exists business_address text;
alter table public.dealers add column if not exists business_city text;
alter table public.dealers add column if not exists business_state text;
alter table public.dealers add column if not exists business_zip text;
alter table public.dealers add column if not exists business_phone text;
alter table public.dealers add column if not exists ein text;
alter table public.dealers add column if not exists brands_carried text;
alter table public.dealers add column if not exists dealer_contacts jsonb default '[]'::jsonb;
alter table public.dealers add column if not exists ar_contact text;
alter table public.dealers add column if not exists ar_phone text;
alter table public.dealers add column if not exists ar_email text;
alter table public.dealers add column if not exists account_number text;
alter table public.dealers add column if not exists routing_number text;
alter table public.dealers add column if not exists effective_date date;
