-- ============================================================================
-- 2026-05-10: RLS Lockdown
-- ============================================================================
-- Applied to production via Supabase SQL Editor on 2026-05-10 by Ben Lloyd.
-- This file is the authoritative record of what was applied.
--
-- Background: every table in the public schema previously had a single
-- "allow all <tablename>" policy on the public role with using (true) and
-- with check (true), plus direct INSERT/UPDATE/DELETE/TRUNCATE grants to
-- the anon role. Effect: anyone with the publicly-visible anon key could
-- read, modify, or delete any row in any table.
--
-- This migration locks it down: dealer-isolated policies on dealer-owned
-- tables, admin override via a SECURITY DEFINER helper function, public
-- INSERT only on dealer_applications (the marketing-site form), FORCE RLS
-- on all tables.
--
-- See CLAUDE.md Section 12 (Change Log, 2026-05-10 entry) for context.
-- ============================================================================

begin;

-- STEP 1: Revoke over-broad grants from anon and authenticated roles.
revoke all on public.audit_log from anon, authenticated;
revoke all on public.cancellations from anon, authenticated;
revoke all on public.contracts from anon, authenticated;
revoke all on public.dealer_applications from anon, authenticated;
revoke all on public.dealer_messages from anon, authenticated;
revoke all on public.dealer_pricing from anon, authenticated;
revoke all on public.dealers from anon, authenticated;
revoke all on public.hin_conflicts from anon, authenticated;
revoke all on public.invoice_items from anon, authenticated;
revoke all on public.invoices from anon, authenticated;
revoke all on public.reimbursements from anon, authenticated;
revoke all on public.services from anon, authenticated;
revoke all on public.tickets from anon, authenticated;

-- Grant back only what the policies will use.
grant select, insert, update on public.audit_log to authenticated;
grant select, insert, update, delete on public.cancellations to authenticated;
grant select, insert, update, delete on public.contracts to authenticated;
grant select on public.dealer_applications to authenticated;
grant insert on public.dealer_applications to anon;
grant insert on public.dealer_applications to authenticated;
grant select, insert, update, delete on public.dealer_messages to authenticated;
grant select, insert, update, delete on public.dealer_pricing to authenticated;
grant select, update on public.dealers to authenticated;
grant select, insert, update, delete on public.hin_conflicts to authenticated;
grant select, insert, update, delete on public.invoice_items to authenticated;
grant select, insert, update, delete on public.invoices to authenticated;
grant select, insert, update, delete on public.reimbursements to authenticated;
grant select on public.services to authenticated;
grant select, insert, update, delete on public.tickets to authenticated;

-- STEP 2: Drop all "allow all" policies.
drop policy if exists "allow all audit_log" on public.audit_log;
drop policy if exists "allow_all_cancellations" on public.cancellations;
drop policy if exists "allow all contracts" on public.contracts;
drop policy if exists "allow all dealer_applications" on public.dealer_applications;
drop policy if exists "allow all dealer_messages" on public.dealer_messages;
drop policy if exists "allow all dealer_pricing" on public.dealer_pricing;
drop policy if exists "allow all dealers" on public.dealers;
drop policy if exists "allow all hin_conflicts" on public.hin_conflicts;
drop policy if exists "allow_all_invoice_items" on public.invoice_items;
drop policy if exists "allow_all_invoices" on public.invoices;
drop policy if exists "allow all reimbursements" on public.reimbursements;
drop policy if exists "allow all services" on public.services;
drop policy if exists "allow all tickets" on public.tickets;

-- STEP 3: Helper function — is the current user an admin?
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.dealers
    where auth_id = auth.uid()
      and is_admin = true
      and coalesce(active, true) = true
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated, anon;

-- STEP 4: Helper function — what is the current dealer's id?
create or replace function public.current_dealer_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.dealers where auth_id = auth.uid() limit 1;
$$;

revoke all on function public.current_dealer_id() from public;
grant execute on function public.current_dealer_id() to authenticated, anon;

-- STEP 5: dealers — read/update own row; admin reads/updates all.
create policy dealers_select_own on public.dealers
  for select to authenticated
  using (auth_id = auth.uid() or public.is_admin());

create policy dealers_update_own on public.dealers
  for update to authenticated
  using (auth_id = auth.uid() or public.is_admin())
  with check (auth_id = auth.uid() or public.is_admin());

-- STEP 6: contracts — dealer-isolated by dealer_id; admin override.
create policy contracts_select_own on public.contracts
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy contracts_insert_own on public.contracts
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy contracts_update_own on public.contracts
  for update to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin())
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy contracts_delete_admin on public.contracts
  for delete to authenticated
  using (public.is_admin());

-- STEP 7: invoice_items
create policy invoice_items_select_own on public.invoice_items
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoice_items_insert_own on public.invoice_items
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoice_items_update_own on public.invoice_items
  for update to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin())
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoice_items_delete_admin on public.invoice_items
  for delete to authenticated
  using (public.is_admin());

-- STEP 8: invoices
create policy invoices_select_own on public.invoices
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoices_insert_own on public.invoices
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoices_update_own on public.invoices
  for update to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin())
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy invoices_delete_admin on public.invoices
  for delete to authenticated
  using (public.is_admin());

-- STEP 9: tickets
create policy tickets_select_own on public.tickets
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy tickets_insert_own on public.tickets
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy tickets_update_own on public.tickets
  for update to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin())
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy tickets_delete_admin on public.tickets
  for delete to authenticated
  using (public.is_admin());

-- STEP 10: reimbursements — dealers read own; admin writes.
create policy reimbursements_select_own on public.reimbursements
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy reimbursements_insert_admin on public.reimbursements
  for insert to authenticated
  with check (public.is_admin());

create policy reimbursements_update_admin on public.reimbursements
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy reimbursements_delete_admin on public.reimbursements
  for delete to authenticated
  using (public.is_admin());

-- STEP 11: cancellations
create policy cancellations_select_own on public.cancellations
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy cancellations_insert_own on public.cancellations
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy cancellations_update_admin on public.cancellations
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy cancellations_delete_admin on public.cancellations
  for delete to authenticated
  using (public.is_admin());

-- STEP 12: dealer_pricing — dealers read own; admin writes.
create policy dealer_pricing_select_own on public.dealer_pricing
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy dealer_pricing_insert_admin on public.dealer_pricing
  for insert to authenticated
  with check (public.is_admin());

create policy dealer_pricing_update_admin on public.dealer_pricing
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy dealer_pricing_delete_admin on public.dealer_pricing
  for delete to authenticated
  using (public.is_admin());

-- STEP 13: dealer_messages — dealer submits and reads own; admin manages all.
create policy dealer_messages_select_own on public.dealer_messages
  for select to authenticated
  using (dealer_id = public.current_dealer_id() or public.is_admin());

create policy dealer_messages_insert_own on public.dealer_messages
  for insert to authenticated
  with check (dealer_id = public.current_dealer_id() or public.is_admin());

create policy dealer_messages_update_admin on public.dealer_messages
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy dealer_messages_delete_admin on public.dealer_messages
  for delete to authenticated
  using (public.is_admin());

-- STEP 14: audit_log — admin-only (Option B from planning).
-- Dealer-side activity feed currently shows nothing; future session
-- will add dealer_id column and proper dealer-side policy.
create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (public.is_admin());

create policy audit_log_insert_admin on public.audit_log
  for insert to authenticated
  with check (public.is_admin());

-- STEP 15: hin_conflicts — admin-only read/update; any auth user can insert.
create policy hin_conflicts_select_admin on public.hin_conflicts
  for select to authenticated
  using (public.is_admin());

create policy hin_conflicts_insert_authenticated on public.hin_conflicts
  for insert to authenticated
  with check (auth.uid() is not null);

create policy hin_conflicts_update_admin on public.hin_conflicts
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- STEP 16: services — reference table; all auth users read; admin writes.
create policy services_select_all on public.services
  for select to authenticated
  using (true);

create policy services_modify_admin on public.services
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- STEP 17: dealer_applications — public INSERT (marketing form); admin manages.
create policy dealer_applications_insert_public on public.dealer_applications
  for insert to anon, authenticated
  with check (true);

create policy dealer_applications_select_admin on public.dealer_applications
  for select to authenticated
  using (public.is_admin());

create policy dealer_applications_update_admin on public.dealer_applications
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy dealer_applications_delete_admin on public.dealer_applications
  for delete to authenticated
  using (public.is_admin());

-- STEP 18: FORCE RLS on every table — closes the table-owner bypass.
alter table public.audit_log force row level security;
alter table public.cancellations force row level security;
alter table public.contracts force row level security;
alter table public.dealer_applications force row level security;
alter table public.dealer_messages force row level security;
alter table public.dealer_pricing force row level security;
alter table public.dealers force row level security;
alter table public.hin_conflicts force row level security;
alter table public.invoice_items force row level security;
alter table public.invoices force row level security;
alter table public.reimbursements force row level security;
alter table public.services force row level security;
alter table public.tickets force row level security;

commit;
