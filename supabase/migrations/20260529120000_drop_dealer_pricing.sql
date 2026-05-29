-- Sprint 8 cleanup: Drop dead per-dealer pricing infrastructure.
-- The per-dealer custom pricing model was replaced May 22 with uniform wholesale.
-- dealer_pricing table has only 2 historical rows for 2 dealers, no longer queried.
-- Audit log entries with action_type='pricing_confirmed' are KEPT as historical record.

-- Drop the dead table
drop table if exists public.dealer_pricing cascade;
