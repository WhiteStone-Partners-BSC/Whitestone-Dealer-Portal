-- Restrict bank column reads: authenticated/anon cannot SELECT payout bank fields from dealers.
-- Admins read via SECURITY DEFINER RPC functions gated by is_admin().
-- Server-side (service_role) reads unchanged for agreement PDF generation.

revoke select (bank_account_number, bank_routing_number, account_number, routing_number)
  on public.dealers
  from authenticated, anon;

grant select (bank_account_number, bank_routing_number, account_number, routing_number)
  on public.dealers
  to service_role;

-- Single dealer (enrollment modal)
create or replace function public.admin_get_dealer_bank(p_dealer_id uuid)
returns table (
  bank_account_number text,
  bank_routing_number text,
  account_number text,
  routing_number text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.bank_account_number,
    d.bank_routing_number,
    d.account_number,
    d.routing_number
  from public.dealers d
  where d.id = p_dealer_id
    and public.is_admin();
$$;

revoke all on function public.admin_get_dealer_bank(uuid) from public;
grant execute on function public.admin_get_dealer_bank(uuid) to authenticated;

-- All dealers (payout CSV banking-on-file check)
create or replace function public.admin_dealer_banking_summary()
returns table (
  dealership_name text,
  bank_account_number text,
  bank_routing_number text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    d.dealership_name,
    d.bank_account_number,
    d.bank_routing_number
  from public.dealers d
  where public.is_admin();
$$;

revoke all on function public.admin_dealer_banking_summary() from public;
grant execute on function public.admin_dealer_banking_summary() to authenticated;
