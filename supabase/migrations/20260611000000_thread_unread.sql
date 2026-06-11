-- Unread badges: per-side last-seen timestamps + denormalized last_sender_type.

alter table message_threads
  add column if not exists dealer_last_seen_at timestamptz,
  add column if not exists admin_last_seen_at  timestamptz,
  add column if not exists last_sender_type    text;

-- Backfill last_sender_type from the newest message per thread
update message_threads mt
set last_sender_type = sub.sender_type
from (
  select distinct on (thread_id) thread_id, sender_type
  from thread_messages
  order by thread_id, created_at desc
) sub
where sub.thread_id = mt.id;
