-- Sprint 8: Customer contract DocuSign tracking on contracts + customer-contracts storage bucket.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- contracts: DocuSign envelope + signature metadata (mirrors dealers pattern)
-- ---------------------------------------------------------------------------
alter table public.contracts
  add column if not exists docusign_envelope_id text,
  add column if not exists docusign_envelope_status text,
  add column if not exists agreement_signed_at timestamptz,
  add column if not exists agreement_signed_by text;

create index if not exists contracts_docusign_envelope_id_idx
  on public.contracts (docusign_envelope_id)
  where docusign_envelope_id is not null;

comment on column public.contracts.docusign_envelope_id is 'DocuSign envelope id for customer enrollment agreement.';
comment on column public.contracts.docusign_envelope_status is 'DocuSign envelope status: sent, completed, declined, etc.';
comment on column public.contracts.agreement_signed_at is 'When customer completed DocuSign signature.';
comment on column public.contracts.agreement_signed_by is 'Signer name from DocuSign envelope-completed payload.';

-- ---------------------------------------------------------------------------
-- dealers: backfill DocuSign columns if Sprint 7 was applied only in dashboard
-- ---------------------------------------------------------------------------
alter table public.dealers
  add column if not exists docusign_envelope_id text,
  add column if not exists docusign_envelope_status text;

create index if not exists dealers_docusign_envelope_id_idx
  on public.dealers (docusign_envelope_id)
  where docusign_envelope_id is not null;

-- ---------------------------------------------------------------------------
-- storage: customer-contracts bucket (signed PDFs from webhook)
-- Path convention: {dealer_id}/{envelope_id}.pdf
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-contracts',
  'customer-contracts',
  false,
  52428800,
  array['application/pdf']::text[]
)
on conflict (id) do nothing;

-- Webhook (authenticated as service role) needs explicit INSERT policy
-- because storage RLS applies even with service key.
drop policy if exists customer_contracts_service_writes on storage.objects;
create policy customer_contracts_service_writes
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'customer-contracts');

-- Dealers read only objects under their own dealer_id folder.
drop policy if exists customer_contracts_select_own on storage.objects;
create policy customer_contracts_select_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'customer-contracts'
    and (storage.foldername(name))[1] = public.current_dealer_id()::text
  );

-- Admins can read any customer contract PDF.
drop policy if exists customer_contracts_select_admin on storage.objects;
create policy customer_contracts_select_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'customer-contracts'
    and public.is_admin()
  );
