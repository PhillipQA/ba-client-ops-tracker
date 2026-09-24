-- BA Client Ops Tracker v0.6.4. Run after schema-v6-tenant-save-integrity.sql.
-- Recovery tokens are private to the server. Existing accounts/data are retained.
begin;

create table if not exists public.password_reset_tokens (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  account_type text not null check (account_type in ('tenant', 'platform')),
  user_id text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  credential_fingerprint text not null,
  email text not null,
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '30 minutes'),
  consumed_at timestamptz,
  check ((account_type = 'tenant' and organization_id is not null)
      or (account_type = 'platform' and organization_id is null))
);
create index if not exists password_reset_user_idx
  on public.password_reset_tokens(account_type, user_id, requested_at desc);
alter table public.password_reset_tokens enable row level security;
revoke all on public.password_reset_tokens from public, anon, authenticated;
grant all on public.password_reset_tokens to service_role;

create or replace function public.issue_password_reset_v7(
  p_account text, p_username text, p_email text, p_token_hash text
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  target_org uuid;
  target_user text;
  target_type text;
  target_email text;
  target_hash text;
  account_label text;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid token hash.' using errcode = '22023';
  end if;
  if lower(replace(trim(p_account), ' ', '_')) = 'internal_admin' then
    target_type := 'platform';
    account_label := 'Internal Admin';
    select id::text, email, password_hash into target_user, target_email, target_hash
      from public.platform_users
      where account_key = 'internal_admin' and lower(username) = lower(trim(p_username))
        and status = 'Active' and deleted_at is null
      for update;
  else
    target_type := 'tenant';
    -- Same lock order as tenant saves: organization, then user, then tokens.
    select id, name into target_org, account_label from public.organizations
      where (lower(slug) = lower(trim(p_account)) or lower(name) = lower(trim(p_account)))
        and status = 'Active' and deleted_at is null
      order by id limit 1 for update;
    if target_org is null then return null; end if;
    select id, email, password_hash into target_user, target_email, target_hash
      from public.app_users
      where organization_id = target_org and lower(username) = lower(trim(p_username))
        and status = 'Active' and deleted_at is null
      for update;
  end if;
  if target_user is null or nullif(trim(target_email), '') is null
      or lower(trim(target_email)) <> lower(trim(p_email)) then return null; end if;
  -- Limits follow the account across client IPs and app instances.
  if exists (select 1 from public.password_reset_tokens
      where account_type = target_type and user_id = target_user
        and requested_at > clock_timestamp() - interval '60 seconds')
    or (select count(*) from public.password_reset_tokens
      where account_type = target_type and user_id = target_user
        and requested_at > clock_timestamp() - interval '1 hour') >= 5 then return null; end if;

  delete from public.password_reset_tokens where expires_at < clock_timestamp() - interval '1 day';
  update public.password_reset_tokens set consumed_at = clock_timestamp()
    where account_type = target_type and user_id = target_user and consumed_at is null;
  insert into public.password_reset_tokens
    (token_hash, account_type, user_id, organization_id, credential_fingerprint, email)
    values (p_token_hash, target_type, target_user, target_org,
      encode(sha256(convert_to(target_hash, 'UTF8')), 'hex'), lower(trim(target_email)));
  return jsonb_build_object('email', trim(target_email), 'account', account_label);
end;
$$;

create or replace function public.redeem_password_reset_v7(p_token_hash text, p_password_hash text)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $$
declare
  reset_row public.password_reset_tokens%rowtype;
  current_hash text;
  current_email text;
  account_row public.app_users%rowtype;
  snapshot jsonb;
  next_accounts jsonb;
  saved_at timestamptz := clock_timestamp();
begin
  if p_password_hash is null or p_password_hash !~ '^\$2[aby]\$12\$[./A-Za-z0-9]{53}$' then
    raise exception 'A secure password hash is required.' using errcode = '22023';
  end if;
  select * into reset_row from public.password_reset_tokens where token_hash = p_token_hash;
  if not found then return null; end if;
  if reset_row.account_type = 'tenant' then
    perform 1 from public.organizations where id = reset_row.organization_id
      and status = 'Active' and deleted_at is null for update;
    if not found then return null; end if;
    select * into account_row from public.app_users
      where id = reset_row.user_id and organization_id = reset_row.organization_id
        and status = 'Active' and deleted_at is null for update;
    if not found then return null; end if;
    current_hash := account_row.password_hash;
    current_email := account_row.email;
  else
    select password_hash, email into current_hash, current_email from public.platform_users
      where id::text = reset_row.user_id and status = 'Active' and deleted_at is null for update;
    if not found then return null; end if;
  end if;
  -- Re-read under lock. Concurrent submissions can succeed only once.
  select * into reset_row from public.password_reset_tokens where token_hash = p_token_hash for update;
  if not found or reset_row.consumed_at is not null or reset_row.expires_at <= clock_timestamp()
      or reset_row.credential_fingerprint is distinct from encode(sha256(convert_to(current_hash, 'UTF8')), 'hex')
      or reset_row.email is distinct from lower(trim(current_email)) then return null; end if;

  if reset_row.account_type = 'platform' then
    update public.platform_users set password_hash = p_password_hash,
      must_change_password = false, password_changed_at = saved_at, updated_at = saved_at
      where id::text = reset_row.user_id;
  else
    update public.app_users set password_hash = p_password_hash, updated_at = saved_at where id = reset_row.user_id;
    -- Keep every server-side credential snapshot consistent in the same transaction.
    select data into snapshot from public.tenant_state where organization_id = reset_row.organization_id for update;
    snapshot := coalesce(snapshot, jsonb_build_object('schemaVersion', 5, 'clients', '[]'::jsonb,
      'projects', '[]'::jsonb, 'items', '[]'::jsonb, 'activity', '[]'::jsonb, 'planner', '[]'::jsonb));
    select coalesce(jsonb_agg(case when item->>'id' = reset_row.user_id
      then jsonb_set(item, '{passwordHash}', to_jsonb(p_password_hash)) else item end order by ordinal), '[]'::jsonb)
      into next_accounts from jsonb_array_elements(coalesce(snapshot->'accounts', '[]'::jsonb)) with ordinality a(item, ordinal);
    if not exists (select 1 from jsonb_array_elements(next_accounts) a where a->>'id' = reset_row.user_id) then
      next_accounts := next_accounts || jsonb_build_array(jsonb_build_object(
        'id', account_row.id, 'username', account_row.username, 'passwordHash', p_password_hash,
        'name', account_row.name, 'email', account_row.email, 'phone', account_row.phone,
        'role', account_row.role, 'modules', account_row.modules, 'status', account_row.status,
        'createdAt', account_row.created_on, 'theme', coalesce(account_row.raw_data->'theme', '"default"'::jsonb)));
    end if;
    snapshot := jsonb_set(snapshot, '{accounts}', next_accounts);
    insert into public.tenant_state(organization_id, data, updated_at) values(reset_row.organization_id, snapshot, saved_at)
      on conflict(organization_id) do update set data = excluded.data, updated_at = excluded.updated_at;
    if reset_row.organization_id = '00000000-0000-0000-0000-000000000001'::uuid then
      insert into public.tracker_state(id, data, updated_at) values('main', snapshot, saved_at)
        on conflict(id) do update set data = excluded.data, updated_at = excluded.updated_at;
    end if;
  end if;
  update public.password_reset_tokens set consumed_at = saved_at
    where account_type = reset_row.account_type and user_id = reset_row.user_id and consumed_at is null;
  return jsonb_build_object('userId', reset_row.user_id, 'accountType', reset_row.account_type,
    'organizationId', reset_row.organization_id);
end;
$$;

revoke all on function public.issue_password_reset_v7(text,text,text,text) from public, anon, authenticated;
revoke all on function public.redeem_password_reset_v7(text,text) from public, anon, authenticated;
grant execute on function public.issue_password_reset_v7(text,text,text,text) to service_role;
grant execute on function public.redeem_password_reset_v7(text,text) to service_role;
notify pgrst, 'reload schema';
commit;
