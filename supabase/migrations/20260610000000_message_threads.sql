-- Two-way dealer<->admin messaging threads, org-aware RLS.

-- THREADS: one row per conversation
create table if not exists message_threads (
  id uuid primary key default gen_random_uuid(),
  dealer_id uuid references dealers(id),
  dealership_name text,
  subject text,                       -- maps from old request_type / a short topic
  status text not null default 'open',-- 'open' | 'closed'
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  created_by_user_id uuid             -- the user (dealer-side) who opened it, if known
);

-- MESSAGES: one row per message within a thread
create table if not exists thread_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references message_threads(id) on delete cascade,
  dealer_id uuid references dealers(id),       -- denormalized for RLS convenience
  sender_type text not null,                   -- 'dealer' | 'admin'
  sender_user_id uuid,                         -- WHO sent it (auth user id)
  sender_name text,                            -- display name snapshot
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_thread_messages_thread on thread_messages(thread_id, created_at);
create index if not exists idx_message_threads_dealer on message_threads(dealer_id, last_message_at desc);

-- Grants (match rls_lockdown pattern: authenticated only, no anon)
revoke all on public.message_threads from anon, authenticated;
revoke all on public.thread_messages from anon, authenticated;
grant select, insert, update, delete on public.message_threads to authenticated;
grant select, insert, update, delete on public.thread_messages to authenticated;

-- RLS
alter table message_threads enable row level security;
alter table thread_messages enable row level security;

-- THREADS policies (org-aware: admin sees all; dealer sees own accessible locations)
create policy message_threads_select on message_threads
  for select to authenticated
  using ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );
create policy message_threads_insert on message_threads
  for insert to authenticated
  with check ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );
create policy message_threads_update on message_threads
  for update to authenticated
  using ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) )
  with check ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );
create policy message_threads_delete_admin on message_threads
  for delete to authenticated
  using ( is_admin() );

-- MESSAGES policies (same access model, keyed by dealer_id on the message row)
create policy thread_messages_select on thread_messages
  for select to authenticated
  using ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );
create policy thread_messages_insert on thread_messages
  for insert to authenticated
  with check ( is_admin() OR (dealer_id = ANY (current_user_accessible_locations())) );
create policy thread_messages_update_admin on thread_messages
  for update to authenticated
  using ( is_admin() ) with check ( is_admin() );
create policy thread_messages_delete_admin on thread_messages
  for delete to authenticated
  using ( is_admin() );

alter table message_threads force row level security;
alter table thread_messages force row level security;
