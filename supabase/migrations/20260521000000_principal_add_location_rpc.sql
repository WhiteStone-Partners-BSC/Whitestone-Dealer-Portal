-- Sprint 3 — Add Location via SECURITY DEFINER RPC
-- Workaround for Supabase RLS bug rejecting direct INSERTs on public.dealers.
-- The function performs all security checks internally (caller must be active principal,
-- org_id derived from session, is_admin hardcoded false). See investigation notes for context.

create or replace function public.principal_add_location(
  p_dealership_name text,
  p_address text default null,
  p_phone text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_role text;
  v_user_status text;
  v_username text;
  v_new_id uuid;
  v_clean_name text;
begin
  -- Validate input
  v_clean_name := btrim(coalesce(p_dealership_name, ''));
  if length(v_clean_name) = 0 then
    raise exception 'Location name is required' using errcode = '22023';
  end if;
  if length(v_clean_name) > 120 then
    raise exception 'Location name must be 120 characters or fewer' using errcode = '22023';
  end if;

  -- Look up caller in public.users (can't trust payload for org_id or role)
  select organization_id, role, status
    into v_org_id, v_role, v_user_status
  from public.users
  where auth_id = auth.uid()
  limit 1;

  if v_org_id is null then
    raise exception 'Caller has no user record' using errcode = '42501';
  end if;
  if v_user_status <> 'active' then
    raise exception 'Caller account is not active' using errcode = '42501';
  end if;
  if v_role <> 'principal' then
    raise exception 'Only principals can add locations' using errcode = '42501';
  end if;

  -- Auto-generate placeholder username (legacy NOT NULL column)
  v_username := 'loc-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  -- Perform the insert (SECURITY DEFINER bypasses RLS)
  insert into public.dealers (
    dealership_name,
    organization_id,
    active,
    is_admin,
    username,
    password,
    address,
    phone
  ) values (
    v_clean_name,
    v_org_id,
    true,
    false,
    v_username,
    'unused',
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), '')
  )
  returning id into v_new_id;

  return json_build_object(
    'id', v_new_id,
    'dealership_name', v_clean_name,
    'organization_id', v_org_id
  );
end;
$$;

grant execute on function public.principal_add_location(text, text, text) to authenticated;

-- Note: this function is the AUTHORITATIVE PATH for principals adding locations.
-- The dealers_insert_principal policy approach is abandoned due to an undiagnosed
-- Supabase RLS bug. If/when that bug is resolved, this function can be deprecated.
