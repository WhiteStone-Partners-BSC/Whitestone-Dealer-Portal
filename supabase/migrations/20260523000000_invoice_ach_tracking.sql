-- Add columns for ACH tracking on invoice_items
alter table invoice_items
  add column if not exists ach_failure_reason text,
  add column if not exists stripe_payment_intent_id text;

-- Index for webhook lookups (webhook fires by payment_intent_id and needs to find the invoice fast)
create index if not exists invoice_items_stripe_pi_idx
  on invoice_items (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

alter table contracts
  add column if not exists stripe_payment_intent_id text;
