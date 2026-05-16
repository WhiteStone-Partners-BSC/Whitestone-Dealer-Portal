-- Rename "Summer Prep" service to "De-Winterization" everywhere
-- Pre-launch safe: only test data exists at time of migration.

begin;

-- 1. Update the services reference table
update public.services
set name = 'De-Winterization'
where name = 'Summer Prep';

-- 2. Update existing tickets that have "Summer Prep" in their service_type
--    service_type is a comma-separated text field (e.g. "Summer Prep, Impeller Service")
update public.tickets
set service_type = regexp_replace(service_type, 'Summer Prep', 'De-Winterization', 'g')
where service_type like '%Summer Prep%';

-- 3. Same pattern for "Basic Summer Prep Inboard" historical variant (if any)
update public.tickets
set service_type = regexp_replace(service_type, 'Basic Summer Prep Inboard', 'De-Winterization (Inboard)', 'g')
where service_type like '%Basic Summer Prep Inboard%';

commit;

-- Verification (run separately, will print results)
select id, name from public.services where name in ('Summer Prep', 'De-Winterization');
select id, service_type from public.tickets where service_type like '%Summer Prep%';  -- should be empty
select id, service_type from public.tickets where service_type like '%De-Winterization%';
