-- Align invoice_items RLS with contracts (org-aware via current_user_accessible_locations).
-- Previously used current_dealer_id() which returns null for org users without a dealers row,
-- causing 403 on add-to-cart for invited users and inconsistent behavior for principals.

-- SELECT
drop policy if exists invoice_items_select_own on public.invoice_items;
create policy invoice_items_select_own on public.invoice_items
  for select to authenticated
  using ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );

-- INSERT
drop policy if exists invoice_items_insert_own on public.invoice_items;
create policy invoice_items_insert_own on public.invoice_items
  for insert to authenticated
  with check ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );

-- UPDATE
drop policy if exists invoice_items_update_own on public.invoice_items;
create policy invoice_items_update_own on public.invoice_items
  for update to authenticated
  using ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) )
  with check ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );

-- DELETE stays admin-only (unchanged) — recreate for completeness/idempotency
drop policy if exists invoice_items_delete_admin on public.invoice_items;
create policy invoice_items_delete_admin on public.invoice_items
  for delete to authenticated
  using ( is_admin() );
