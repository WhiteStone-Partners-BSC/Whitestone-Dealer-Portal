-- Run this in the Supabase SQL editor before using the HIN conflicts queue in the dealer portal.

create table if not exists hin_conflicts (
  id uuid default gen_random_uuid() primary key,
  hin text not null,
  attempted_by_dealer text,
  attempted_customer_name text,
  existing_customer_name text,
  existing_contract_status text,
  reason text,
  resolved boolean default false,
  created_at timestamp with time zone default now()
);

alter table hin_conflicts enable row level security;

create policy "allow all hin_conflicts" on hin_conflicts for all using (true) with check (true);
