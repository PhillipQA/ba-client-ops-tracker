-- BA Client Ops Tracker: database schema (version 36)
--
-- Creates every table, constraint, index and function the app needs on an empty PostgreSQL 14+ database, plus the
-- two starting sign-ins. Run it once, as the same database user the app connects with (DATABASE_URL):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
--
-- It stops without changing anything if the app's tables already exist, so it is safe against an existing database.
-- It creates no data beyond the starting sign-ins, and stores no passwords: the first sign-in of each account uses
-- INTERNAL_ADMIN_BOOTSTRAP_PASSWORD or BXI_CORE_BOOTSTRAP_PASSWORD from the server's settings (12+ characters), and
-- must then be changed.
--
-- Changing the schema later: add database/migrations/schema-v36-<what>.sql (and so on), apply it to every database,
-- and fold it into this file so a new install gets it too. See database/README.md.

begin;
set local check_function_bodies = false;
select pg_advisory_xact_lock(hashtext('ba_client_ops_schema'));

do $guard$
declare
  name text;
begin
  foreach name in array array[
    'activity_logs','app_settings','app_users','audit_logs','clients','data_migration_runs','document_attachments'
    ,'document_versions','documents','drf_error_logs','gmail_accounts','google_calendar_accounts','google_calendar
    _connections','inquiries','organizations','password_reset_tokens','planner_activities','platform_users','proje
    cts','task_statuses','tasks','tenant_ai_agents','tenant_dochub_accounts','tenant_dochub_documents','tenant_dri
    ve_accounts','tenant_email_templates','tenant_integrations','tenant_reports','tenant_state','tenant_templates'
    ,'tenant_tracker_changes','tenant_tracker_rows','tenant_tracker_sources','tenant_tracker_task_links','tenant_t
    racker_templates','tenant_trackers','tracker_evidence_files','tracker_state','user_communication_settings','us
    er_communications','user_email_signatures','user_github_connections','user_github_issues','user_gitlab_connect
    ions','user_gitlab_issues'
  ] loop
    if to_regclass(format('public.%I', name)) is not null then
      raise exception 'Stopped: public.% already exists, so this database is already set up. Nothing was changed.', name;
    end if;
  end loop;
end;
$guard$;

-- ----------------------------------------------------------------------------------------------------
-- Functions: saving the workspace (v16, which calls v6), password recovery, and the legacy workspace timestamp
-- ----------------------------------------------------------------------------------------------------

CREATE FUNCTION public.issue_password_reset_v7(p_account text, p_username text, p_email text, p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;

CREATE FUNCTION public.redeem_password_reset_v7(p_token_hash text, p_password_hash text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
$_$;

CREATE FUNCTION public.save_tenant_state_v16(p_organization_id uuid, p_state jsonb, p_expected_updated_at timestamp with time zone, p_records jsonb DEFAULT NULL::jsonb, p_audit_entries jsonb DEFAULT '[]'::jsonb, p_actor_id text DEFAULT NULL::text, p_reason text DEFAULT 'tracker-save'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare current_updated_at timestamptz;
begin
  -- Use the same lock as v6, including for a tenant's first snapshot.
  perform 1 from public.organizations where id = p_organization_id for update;
  select updated_at into current_updated_at from public.tenant_state where organization_id = p_organization_id;
  if current_updated_at is distinct from p_expected_updated_at then
    raise exception 'This workspace changed while saving. Reload and reapply your change; nothing was overwritten.' using errcode = '40001';
  end if;
  return public.save_tenant_state_v6(p_organization_id, p_state, p_records, p_audit_entries, p_actor_id, p_reason);
end;
$$;

CREATE FUNCTION public.save_tenant_state_v6(p_organization_id uuid, p_state jsonb, p_records jsonb DEFAULT NULL::jsonb, p_audit_entries jsonb DEFAULT '[]'::jsonb, p_actor_id text DEFAULT NULL::text, p_reason text DEFAULT 'tracker-save'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  tenant_status text;
  table_name text;
  collection_name text;
  row_data jsonb;
  ids text[];
  column_names text;
  update_columns text;
  requested integer;
  written integer;
  foreign_id boolean;
  counts jsonb := '{}'::jsonb;
  saved_at timestamptz := clock_timestamp();
  supported_tables text[] := array['clients','projects','tasks','inquiries','activity_logs','planner_activities','app_users','task_statuses','app_settings'];
begin
  if jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'A tracker data object is required.' using errcode = '22023';
  end if;

  -- Serialize saves within a workspace, including its compatibility snapshot.
  select status into tenant_status from public.organizations
  where id = p_organization_id and deleted_at is null for update;
  if not found or (p_records is not null and tenant_status <> 'Active') then
    raise exception 'The workspace is unavailable.' using errcode = '42501';
  end if;

  -- Validate the JSON snapshot before any write. Check items against BOTH tables
  -- so changing a Task into an Inquiry cannot evade ownership validation.
  for table_name, collection_name in
    select * from (values
      ('clients','clients'), ('projects','projects'), ('tasks','items'),
      ('inquiries','items'), ('activity_logs','activity'),
      ('planner_activities','planner'), ('app_users','accounts')
    ) as groups(table_name, collection_name)
  loop
    row_data := coalesce(p_state->collection_name, '[]'::jsonb);
    if jsonb_typeof(row_data) <> 'array' then
      raise exception 'Invalid % collection.', collection_name using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(row_data) entry
               where jsonb_typeof(entry) <> 'object' or coalesce(entry->>'id','') = '') then
      raise exception 'Every record must have an ID.' using errcode = '22023';
    end if;
    select coalesce(array_agg(entry->>'id'), array[]::text[]) into ids from jsonb_array_elements(row_data) entry;
    if cardinality(ids) <> (select count(distinct id) from unnest(ids) id) then
      raise exception 'Duplicate record IDs are not allowed.' using errcode = '22023';
    end if;
    execute format('select exists (select 1 from public.%I where id = any($1) and organization_id <> $2)', table_name)
      into foreign_id using ids, p_organization_id;
    if foreign_id then
      raise exception 'A record ID belongs to another workspace. No changes were saved.' using errcode = '42501';
    end if;
  end loop;

  if p_records is not null then
    if jsonb_typeof(p_records) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_records) key where not (key = any(supported_tables)))
       or (select count(*) from jsonb_object_keys(p_records)) <> cardinality(supported_tables) then
      raise exception 'A complete normalized record set is required.' using errcode = '22023';
    end if;

    foreach table_name in array supported_tables loop
      row_data := p_records->table_name;
      if jsonb_typeof(row_data) is distinct from 'array' then
        raise exception 'Invalid normalized records.' using errcode = '22023';
      end if;
      requested := jsonb_array_length(row_data);
      select coalesce(array_agg(entry->>'id'), array[]::text[]) into ids from jsonb_array_elements(row_data) entry;
      if cardinality(ids) <> (select count(distinct id) from unnest(ids) id) then
        raise exception 'Duplicate record IDs are not allowed.' using errcode = '22023';
      end if;

      if requested > 0 then
        -- Only the privileged Node server can invoke this RPC. Its fixed record
        -- mappings select application columns; tenant ownership is assigned here.
        select string_agg(format('%I', key), ',' order by key),
               string_agg(format('%1$I = excluded.%1$I', key), ',' order by key) filter (where key <> 'id')
          into column_names, update_columns
          from jsonb_object_keys(row_data->0) key
          where key not in ('organization_id','created_at','updated_at','deleted_at','is_platform_admin');
        execute format(
          'insert into public.%1$I (%2$s,organization_id,updated_at,deleted_at)
           select %2$s,$2,$3,null from jsonb_populate_recordset(null::public.%1$I,$1)
           on conflict (id) do update set %3$s,updated_at=excluded.updated_at,deleted_at=null
           where %1$I.organization_id = excluded.organization_id',
          table_name, column_names, update_columns
        ) using row_data, p_organization_id, saved_at;
        get diagnostics written = row_count;
        -- Also protects a new-ID collision that occurs after the snapshot check.
        if written <> requested then
          raise exception 'A record ID belongs to another workspace. No changes were saved.' using errcode = '42501';
        end if;
      end if;

      execute format('update public.%I set deleted_at=$3,updated_at=$3 where organization_id=$2 and deleted_at is null and not (id = any($1))', table_name)
        using ids, p_organization_id, saved_at;
      counts := counts || jsonb_build_object(table_name, requested);
    end loop;

    insert into public.data_migration_runs (id,organization_id,status,reason,started_at,completed_at,started_by,counts)
    values (gen_random_uuid(),p_organization_id,'completed',p_reason,saved_at,saved_at,p_actor_id,counts);
  end if;

  insert into public.audit_logs
    (id,organization_id,entity_type,entity_id,action,changed_fields,before_data,after_data,changed_by,changed_by_name,source)
  select id,p_organization_id,entity_type,entity_id,action,changed_fields,before_data,after_data,changed_by,changed_by_name,source
  from jsonb_populate_recordset(null::public.audit_logs,coalesce(p_audit_entries,'[]'::jsonb));

  insert into public.tenant_state (organization_id,data,updated_at)
  values (p_organization_id,p_state,saved_at)
  on conflict (organization_id) do update set data=excluded.data,updated_at=excluded.updated_at;

  if p_organization_id = '00000000-0000-0000-0000-000000000001' then
    insert into public.tracker_state (id,data,updated_at) values ('main',p_state,saved_at)
    on conflict (id) do update set data=excluded.data,updated_at=excluded.updated_at;
  end if;

  return jsonb_build_object('ready',true,'syncedAt',saved_at,'counts',counts);
end;
$_$;

CREATE FUNCTION public.touch_tracker_state_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;


-- ----------------------------------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------------------------------

CREATE TABLE public.activity_logs (
    id text NOT NULL,
    client_id text,
    project_id text,
    activity_date date,
    text text DEFAULT ''::text NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.app_settings (
    id text NOT NULL,
    setting_key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.app_users (
    id text NOT NULL,
    username text NOT NULL,
    password_hash text DEFAULT ''::text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'Contributor'::text NOT NULL,
    modules jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    created_on date,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL,
    is_platform_admin boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone
);

CREATE TABLE public.audit_logs (
    id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    changed_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    before_data jsonb,
    after_data jsonb,
    changed_by text,
    changed_by_name text,
    source text DEFAULT 'tracker'::text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL
);

CREATE TABLE public.clients (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    contact text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    health text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.data_migration_runs (
    id uuid NOT NULL,
    status text NOT NULL,
    reason text DEFAULT 'manual-migration'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    started_by text,
    counts jsonb,
    error text,
    organization_id uuid NOT NULL
);

CREATE TABLE public.document_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    storage_path text NOT NULL,
    file_name text NOT NULL,
    mime_type text,
    file_size bigint,
    attachment_role text,
    uploaded_by text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid,
    version_number integer NOT NULL,
    storage_path text,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL
);

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_type text NOT NULL,
    client_id text,
    project_id text,
    status text DEFAULT 'Draft'::text NOT NULL,
    extracted_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    generated_storage_path text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.drf_error_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    stage text NOT NULL,
    source text NOT NULL,
    message text NOT NULL,
    error_code text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drf_error_logs_source_check CHECK ((source = ANY (ARRAY['browser'::text, 'server'::text]))),
    CONSTRAINT drf_error_logs_stage_check CHECK ((stage = ANY (ARRAY['cor_upload'::text, 'cor_local'::text, 'cor_ai'::text, 'template_render'::text, 'download'::text, 'dochub'::text])))
);

CREATE TABLE public.gmail_accounts (
    tenant_id uuid NOT NULL,
    platform_enabled boolean DEFAULT false NOT NULL,
    account_enabled boolean DEFAULT false NOT NULL,
    encrypted_config text,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.google_calendar_accounts (
    tenant_id uuid NOT NULL,
    platform_enabled boolean DEFAULT false NOT NULL,
    account_enabled boolean DEFAULT false NOT NULL,
    encrypted_config text,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.google_calendar_connections (
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    config_revision uuid NOT NULL,
    encrypted_tokens text NOT NULL,
    selected_calendars jsonb DEFAULT '["primary"]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT google_calendar_connections_selected_calendars_check CHECK (((jsonb_typeof(selected_calendars) = 'array'::text) AND (jsonb_array_length(selected_calendars) <= 10)))
);

CREATE TABLE public.inquiries (
    id text NOT NULL,
    client_id text,
    project_id text,
    title text DEFAULT ''::text NOT NULL,
    priority text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    waiting_on text DEFAULT ''::text NOT NULL,
    owner text DEFAULT ''::text NOT NULL,
    date_raised date,
    follow_up_date date,
    description text DEFAULT ''::text NOT NULL,
    resolution text DEFAULT ''::text NOT NULL,
    resolved_date date,
    source text DEFAULT ''::text NOT NULL,
    external_source_id text,
    source_sender text,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    enabled_modules jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT organizations_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Suspended'::text])))
);

CREATE TABLE public.password_reset_tokens (
    token_hash text NOT NULL,
    account_type text NOT NULL,
    user_id text NOT NULL,
    organization_id uuid,
    credential_fingerprint text NOT NULL,
    email text NOT NULL,
    requested_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (clock_timestamp() + '00:30:00'::interval) NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT password_reset_tokens_account_type_check CHECK ((account_type = ANY (ARRAY['tenant'::text, 'platform'::text]))),
    CONSTRAINT password_reset_tokens_check CHECK ((((account_type = 'tenant'::text) AND (organization_id IS NOT NULL)) OR ((account_type = 'platform'::text) AND (organization_id IS NULL)))),
    CONSTRAINT password_reset_tokens_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.planner_activities (
    id text NOT NULL,
    client_id text,
    project_id text,
    title text DEFAULT ''::text NOT NULL,
    activity_date date,
    start_time text,
    end_time text,
    end_date date,
    all_day boolean DEFAULT false NOT NULL,
    source text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    calendar_event_id text,
    calendar_link text,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.platform_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_key text DEFAULT 'internal_admin'::text NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    must_change_password boolean DEFAULT true NOT NULL,
    password_changed_at timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT platform_users_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Disabled'::text])))
);

CREATE TABLE public.projects (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    target_date date,
    summary text DEFAULT ''::text NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.task_statuses (
    id text NOT NULL,
    label text NOT NULL,
    is_completed boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.tasks (
    id text NOT NULL,
    client_id text,
    project_id text,
    parent_task_id text,
    subtask_order integer,
    title text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'Task'::text NOT NULL,
    priority text DEFAULT ''::text NOT NULL,
    status text DEFAULT ''::text NOT NULL,
    waiting_on text DEFAULT ''::text NOT NULL,
    owner text DEFAULT ''::text NOT NULL,
    date_raised date,
    due_date date,
    follow_up_date date,
    description text DEFAULT ''::text NOT NULL,
    resolution text DEFAULT ''::text NOT NULL,
    resolved_date date,
    source text DEFAULT ''::text NOT NULL,
    external_source_id text,
    source_sender text,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    organization_id uuid NOT NULL
);

CREATE TABLE public.tenant_ai_agents (
    tenant_id uuid NOT NULL,
    agent_id text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    encrypted_secret text NOT NULL,
    secret_suffix text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    connection_status text DEFAULT 'untested'::text NOT NULL,
    last_tested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_ai_agents_agent_id_check CHECK ((agent_id = ANY (ARRAY['ba_assistant'::text, 'document'::text]))),
    CONSTRAINT tenant_ai_agents_connection_status_check CHECK ((connection_status = ANY (ARRAY['untested'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT tenant_ai_agents_model_check CHECK (((length(model) >= 1) AND (length(model) <= 100))),
    CONSTRAINT tenant_ai_agents_provider_check CHECK ((provider = ANY (ARRAY['gemini'::text, 'openai'::text, 'anthropic'::text, 'deepseek'::text]))),
    CONSTRAINT tenant_ai_agents_secret_suffix_check CHECK ((length(secret_suffix) = 4))
);

CREATE TABLE public.tenant_dochub_accounts (
    tenant_id uuid NOT NULL,
    encrypted_api_key text NOT NULL,
    key_suffix text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    encrypted_webhook_secret text,
    webhook_id text,
    webhook_url text,
    verified_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_dochub_documents (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    document_id text,
    data jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_drive_accounts (
    tenant_id uuid NOT NULL,
    drive_email text NOT NULL,
    encrypted_refresh_token text NOT NULL,
    gmail_config_revision uuid NOT NULL,
    root_folder_id text,
    folders jsonb DEFAULT '{}'::jsonb NOT NULL,
    connected_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_email_templates (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    shared boolean DEFAULT true NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    created_by_name text DEFAULT ''::text NOT NULL,
    updated_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_email_templates_body_check CHECK ((length(body) <= 30000)),
    CONSTRAINT tenant_email_templates_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT tenant_email_templates_subject_check CHECK ((length(subject) <= 200))
);

CREATE TABLE public.tenant_integrations (
    tenant_id uuid NOT NULL,
    integration_type text NOT NULL,
    encrypted_secret text NOT NULL,
    secret_suffix text NOT NULL,
    provider_identity text,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    connection_status text DEFAULT 'untested'::text NOT NULL,
    last_tested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_integrations_connection_status_check CHECK ((connection_status = ANY (ARRAY['untested'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT tenant_integrations_integration_type_check CHECK ((integration_type = ANY (ARRAY['discord'::text, 'openai'::text, 'seeds'::text]))),
    CONSTRAINT tenant_integrations_secret_suffix_check CHECK ((length(secret_suffix) = 4))
);

CREATE TABLE public.tenant_reports (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text DEFAULT 'report'::text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    folder_id text DEFAULT ''::text NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    definition jsonb DEFAULT '{}'::jsonb NOT NULL,
    template_key text DEFAULT ''::text NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    created_by_name text DEFAULT ''::text NOT NULL,
    updated_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_reports_kind_check CHECK ((kind = ANY (ARRAY['report'::text, 'folder'::text, 'template'::text, 'query'::text]))),
    CONSTRAINT tenant_reports_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120)))
);

CREATE TABLE public.tenant_state (
    organization_id uuid NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_templates (
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    content_base64 text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    template_type text DEFAULT 'drf'::text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT tenant_templates_content_base64_check CHECK ((octet_length(content_base64) <= 7340032)),
    CONSTRAINT tenant_templates_template_type_check CHECK ((template_type = ANY (ARRAY['drf'::text, 'brd'::text, 'fsd'::text, 'signoff'::text, 'golive'::text, 'uat'::text, 'uatdeploy'::text, 'training'::text])))
);

CREATE TABLE public.tenant_tracker_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tracker_id uuid NOT NULL,
    row_id text DEFAULT ''::text NOT NULL,
    actor_id text DEFAULT ''::text NOT NULL,
    actor_name text DEFAULT ''::text NOT NULL,
    kind text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_tracker_rows (
    tenant_id uuid NOT NULL,
    tracker_id uuid NOT NULL,
    id uuid NOT NULL,
    "position" bigint NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets jsonb DEFAULT '{}'::jsonb NOT NULL,
    task_id text DEFAULT ''::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_key text DEFAULT ''::text NOT NULL,
    source_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_missing boolean DEFAULT false NOT NULL,
    review boolean DEFAULT false NOT NULL,
    sheet_issue jsonb,
    highlight text DEFAULT ''::text NOT NULL
);

CREATE TABLE public.tenant_tracker_sources (
    tenant_id uuid NOT NULL,
    tracker_id uuid NOT NULL,
    spreadsheet_id text NOT NULL,
    spreadsheet_name text DEFAULT ''::text NOT NULL,
    tab text NOT NULL,
    key_header text NOT NULL,
    header_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    mode text DEFAULT 'one_way'::text NOT NULL,
    connected_by text DEFAULT ''::text NOT NULL,
    connected_by_name text DEFAULT ''::text NOT NULL,
    connected_email text DEFAULT ''::text NOT NULL,
    last_synced_at timestamp with time zone,
    last_status text DEFAULT 'never'::text NOT NULL,
    last_error text DEFAULT ''::text NOT NULL,
    last_report jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_tracker_sources_mode_check CHECK ((mode = ANY (ARRAY['one_way'::text, 'two_way'::text])))
);

CREATE TABLE public.tenant_tracker_task_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tracker_id uuid NOT NULL,
    row_id uuid NOT NULL,
    column_id text DEFAULT ''::text NOT NULL,
    task_id text NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    created_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tenant_tracker_templates (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL,
    about text DEFAULT ''::text NOT NULL,
    columns jsonb DEFAULT '[]'::jsonb NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    template_key text DEFAULT ''::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    created_by_name text DEFAULT ''::text NOT NULL,
    updated_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    step_tasks boolean,
    CONSTRAINT tenant_tracker_templates_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80)))
);

CREATE TABLE public.tenant_trackers (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL,
    client_id text DEFAULT ''::text NOT NULL,
    project_id text DEFAULT ''::text NOT NULL,
    private boolean DEFAULT false NOT NULL,
    template text DEFAULT ''::text NOT NULL,
    columns jsonb DEFAULT '[]'::jsonb NOT NULL,
    views jsonb DEFAULT '[]'::jsonb NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by text DEFAULT ''::text NOT NULL,
    created_by_name text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    timeline jsonb DEFAULT '{}'::jsonb NOT NULL,
    step_tasks boolean,
    CONSTRAINT tenant_trackers_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120)))
);

CREATE TABLE public.tracker_evidence_files (
    bucket text NOT NULL,
    storage_path text NOT NULL,
    mime_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tracker_state (
    id text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_communication_settings (
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    discord_user_id text,
    discord_capture_mentions boolean DEFAULT true NOT NULL,
    gmail_email text,
    gmail_refresh_token text,
    gmail_labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gmail_config_revision uuid,
    gmail_label_catalog jsonb DEFAULT '[]'::jsonb NOT NULL,
    gmail_sync_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT user_communication_settings_discord_user_id_check CHECK (((discord_user_id IS NULL) OR (discord_user_id ~ '^[0-9]{15,22}$'::text)))
);

CREATE TABLE public.user_communications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    source text NOT NULL,
    external_id text,
    thread_id text,
    subject text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    sender text DEFAULT ''::text NOT NULL,
    source_label text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    client_id text,
    project_id text,
    status text DEFAULT 'New'::text NOT NULL,
    linked_task_id text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_labels text[] DEFAULT '{}'::text[] NOT NULL,
    linked_task_ids text[] DEFAULT '{}'::text[] NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT user_communications_source_check CHECK ((source = ANY (ARRAY['Gmail'::text, 'Discord'::text, 'Manual'::text]))),
    CONSTRAINT user_communications_status_check CHECK ((status = ANY (ARRAY['New'::text, 'Open'::text, 'Resolved'::text, 'Archived'::text])))
);

CREATE TABLE public.user_email_signatures (
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    signature text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_email_signatures_signature_check CHECK ((length(signature) <= 2000))
);

CREATE TABLE public.user_github_connections (
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    github_user_id bigint NOT NULL,
    github_login text NOT NULL,
    encrypted_token text,
    repositories jsonb DEFAULT '[]'::jsonb NOT NULL,
    sync_cursor jsonb,
    last_synced_at timestamp with time zone,
    retry_after timestamp with time zone,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_github_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    github_user_id bigint NOT NULL,
    github_id bigint NOT NULL,
    number integer NOT NULL,
    repository text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    html_url text NOT NULL,
    state text NOT NULL,
    state_reason text,
    creator text NOT NULL,
    assignees jsonb DEFAULT '[]'::jsonb NOT NULL,
    labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    milestone text DEFAULT ''::text NOT NULL,
    comments_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_me boolean DEFAULT false NOT NULL,
    assigned_to_me boolean DEFAULT false NOT NULL,
    available boolean DEFAULT true NOT NULL,
    qa_status text DEFAULT 'Not started'::text NOT NULL,
    linked_task_id text,
    CONSTRAINT user_github_issues_qa_status_check CHECK ((qa_status = ANY (ARRAY['Not started'::text, 'In progress'::text, 'Needs retest'::text, 'Passed'::text, 'Failed'::text, 'Blocked'::text]))),
    CONSTRAINT user_github_issues_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closed'::text])))
);

CREATE TABLE public.user_gitlab_connections (
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    instance_url text NOT NULL,
    gitlab_user_id bigint NOT NULL,
    gitlab_login text NOT NULL,
    encrypted_token text,
    repositories jsonb DEFAULT '[]'::jsonb NOT NULL,
    sync_cursor jsonb,
    last_synced_at timestamp with time zone,
    retry_after timestamp with time zone,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_gitlab_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_user_id text NOT NULL,
    instance_url text NOT NULL,
    gitlab_user_id bigint NOT NULL,
    gitlab_id bigint NOT NULL,
    number integer NOT NULL,
    repository text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    html_url text NOT NULL,
    state text NOT NULL,
    state_reason text,
    creator text NOT NULL,
    assignees jsonb DEFAULT '[]'::jsonb NOT NULL,
    labels jsonb DEFAULT '[]'::jsonb NOT NULL,
    milestone text DEFAULT ''::text NOT NULL,
    comments_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_me boolean DEFAULT false NOT NULL,
    assigned_to_me boolean DEFAULT false NOT NULL,
    available boolean DEFAULT true NOT NULL,
    qa_status text DEFAULT 'Not started'::text NOT NULL,
    linked_task_id text,
    CONSTRAINT user_gitlab_issues_qa_status_check CHECK ((qa_status = ANY (ARRAY['Not started'::text, 'In progress'::text, 'Needs retest'::text, 'Passed'::text, 'Failed'::text, 'Blocked'::text]))),
    CONSTRAINT user_gitlab_issues_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closed'::text])))
);


-- ----------------------------------------------------------------------------------------------------
-- Primary keys, unique and check constraints
-- ----------------------------------------------------------------------------------------------------

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_setting_key_key UNIQUE (setting_key);

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.data_migration_runs
    ADD CONSTRAINT data_migration_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_version_number_key UNIQUE (document_id, version_number);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drf_error_logs
    ADD CONSTRAINT drf_error_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gmail_accounts
    ADD CONSTRAINT gmail_accounts_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY public.google_calendar_accounts
    ADD CONSTRAINT google_calendar_accounts_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY public.google_calendar_connections
    ADD CONSTRAINT google_calendar_connections_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY public.planner_activities
    ADD CONSTRAINT planner_activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.platform_users
    ADD CONSTRAINT platform_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.task_statuses
    ADD CONSTRAINT task_statuses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_ai_agents
    ADD CONSTRAINT tenant_ai_agents_pkey PRIMARY KEY (tenant_id, agent_id);

ALTER TABLE ONLY public.tenant_dochub_accounts
    ADD CONSTRAINT tenant_dochub_accounts_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY public.tenant_dochub_documents
    ADD CONSTRAINT tenant_dochub_documents_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.tenant_dochub_documents
    ADD CONSTRAINT tenant_dochub_documents_tenant_id_document_id_key UNIQUE (tenant_id, document_id);

ALTER TABLE ONLY public.tenant_drive_accounts
    ADD CONSTRAINT tenant_drive_accounts_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY public.tenant_email_templates
    ADD CONSTRAINT tenant_email_templates_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.tenant_integrations
    ADD CONSTRAINT tenant_integrations_pkey PRIMARY KEY (tenant_id, integration_type);

ALTER TABLE ONLY public.tenant_reports
    ADD CONSTRAINT tenant_reports_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.tenant_state
    ADD CONSTRAINT tenant_state_pkey PRIMARY KEY (organization_id);

ALTER TABLE ONLY public.tenant_templates
    ADD CONSTRAINT tenant_templates_pkey PRIMARY KEY (tenant_id, template_type);

ALTER TABLE ONLY public.tenant_tracker_changes
    ADD CONSTRAINT tenant_tracker_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_tracker_rows
    ADD CONSTRAINT tenant_tracker_rows_pkey PRIMARY KEY (tenant_id, tracker_id, id);

ALTER TABLE ONLY public.tenant_tracker_sources
    ADD CONSTRAINT tenant_tracker_sources_pkey PRIMARY KEY (tenant_id, tracker_id);

ALTER TABLE ONLY public.tenant_tracker_task_links
    ADD CONSTRAINT tenant_tracker_task_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_tracker_templates
    ADD CONSTRAINT tenant_tracker_templates_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.tenant_trackers
    ADD CONSTRAINT tenant_trackers_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY public.tracker_evidence_files
    ADD CONSTRAINT tracker_evidence_files_pkey PRIMARY KEY (bucket, storage_path);

ALTER TABLE ONLY public.tracker_state
    ADD CONSTRAINT tracker_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_communication_settings
    ADD CONSTRAINT user_communication_settings_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY public.user_communication_settings
    ADD CONSTRAINT user_communication_settings_tenant_id_discord_user_id_key UNIQUE (tenant_id, discord_user_id);

ALTER TABLE ONLY public.user_communications
    ADD CONSTRAINT user_communications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_communications
    ADD CONSTRAINT user_communications_tenant_id_owner_user_id_source_external_key UNIQUE (tenant_id, owner_user_id, source, external_id);

ALTER TABLE ONLY public.user_email_signatures
    ADD CONSTRAINT user_email_signatures_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY public.user_github_connections
    ADD CONSTRAINT user_github_connections_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY public.user_github_issues
    ADD CONSTRAINT user_github_issues_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_github_issues
    ADD CONSTRAINT user_github_issues_tenant_id_owner_user_id_github_user_id_g_key UNIQUE (tenant_id, owner_user_id, github_user_id, github_id);

ALTER TABLE ONLY public.user_gitlab_connections
    ADD CONSTRAINT user_gitlab_connections_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY public.user_gitlab_issues
    ADD CONSTRAINT user_gitlab_issues_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_gitlab_issues
    ADD CONSTRAINT user_gitlab_issues_tenant_id_owner_user_id_instance_url_git_key UNIQUE (tenant_id, owner_user_id, instance_url, gitlab_user_id, gitlab_id);


-- ----------------------------------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------------------------------

CREATE INDEX activity_logs_client_id_idx ON public.activity_logs USING btree (client_id);

CREATE INDEX activity_logs_org_idx ON public.activity_logs USING btree (organization_id);

CREATE INDEX activity_logs_project_id_idx ON public.activity_logs USING btree (project_id);

CREATE INDEX app_settings_org_idx ON public.app_settings USING btree (organization_id);

CREATE UNIQUE INDEX app_users_id_organization_unique ON public.app_users USING btree (id, organization_id);

CREATE INDEX app_users_org_idx ON public.app_users USING btree (organization_id);

CREATE UNIQUE INDEX app_users_org_username_lower_uidx ON public.app_users USING btree (organization_id, lower(username)) WHERE (deleted_at IS NULL);

CREATE INDEX audit_logs_changed_at_idx ON public.audit_logs USING btree (changed_at DESC);

CREATE INDEX audit_logs_entity_idx ON public.audit_logs USING btree (entity_type, entity_id, changed_at DESC);

CREATE INDEX audit_logs_org_idx ON public.audit_logs USING btree (organization_id, changed_at DESC);

CREATE INDEX clients_org_idx ON public.clients USING btree (organization_id);

CREATE INDEX document_attachments_org_idx ON public.document_attachments USING btree (organization_id);

CREATE INDEX document_versions_org_idx ON public.document_versions USING btree (organization_id);

CREATE INDEX documents_org_idx ON public.documents USING btree (organization_id);

CREATE INDEX drf_error_logs_user_recent ON public.drf_error_logs USING btree (tenant_id, user_id, created_at DESC);

CREATE INDEX inquiries_client_id_idx ON public.inquiries USING btree (client_id);

CREATE UNIQUE INDEX inquiries_external_source_id_uidx ON public.inquiries USING btree (external_source_id) WHERE (external_source_id IS NOT NULL);

CREATE INDEX inquiries_org_idx ON public.inquiries USING btree (organization_id);

CREATE INDEX inquiries_project_id_idx ON public.inquiries USING btree (project_id);

CREATE INDEX migration_runs_org_idx ON public.data_migration_runs USING btree (organization_id, started_at DESC);

CREATE INDEX password_reset_user_idx ON public.password_reset_tokens USING btree (account_type, user_id, requested_at DESC);

CREATE INDEX planner_activities_org_idx ON public.planner_activities USING btree (organization_id);

CREATE UNIQUE INDEX platform_users_account_username_uidx ON public.platform_users USING btree (lower(account_key), lower(username)) WHERE (deleted_at IS NULL);

CREATE INDEX projects_org_idx ON public.projects USING btree (organization_id);

CREATE INDEX task_statuses_org_idx ON public.task_statuses USING btree (organization_id);

CREATE INDEX tasks_client_id_idx ON public.tasks USING btree (client_id);

CREATE INDEX tasks_due_date_idx ON public.tasks USING btree (due_date);

CREATE INDEX tasks_follow_up_date_idx ON public.tasks USING btree (follow_up_date);

CREATE INDEX tasks_org_idx ON public.tasks USING btree (organization_id);

CREATE INDEX tasks_parent_task_id_idx ON public.tasks USING btree (parent_task_id);

CREATE INDEX tasks_project_id_idx ON public.tasks USING btree (project_id);

CREATE UNIQUE INDEX tenant_discord_bot_unique ON public.tenant_integrations USING btree (provider_identity) WHERE ((integration_type = 'discord'::text) AND (provider_identity IS NOT NULL));

CREATE INDEX tenant_dochub_documents_recent ON public.tenant_dochub_documents USING btree (tenant_id, updated_at DESC);

CREATE INDEX tenant_email_templates_name ON public.tenant_email_templates USING btree (tenant_id, name);

CREATE INDEX tenant_reports_by_owner ON public.tenant_reports USING btree (tenant_id, created_by);

CREATE INDEX tenant_tracker_changes_row ON public.tenant_tracker_changes USING btree (tenant_id, tracker_id, row_id, created_at DESC);

CREATE INDEX tenant_tracker_rows_order ON public.tenant_tracker_rows USING btree (tenant_id, tracker_id, "position", created_at);

CREATE INDEX tenant_tracker_rows_review ON public.tenant_tracker_rows USING btree (tenant_id, tracker_id) WHERE review;

CREATE INDEX tenant_tracker_rows_sheet_issue ON public.tenant_tracker_rows USING btree (tenant_id, tracker_id) WHERE (sheet_issue IS NOT NULL);

CREATE INDEX tenant_tracker_rows_source ON public.tenant_tracker_rows USING btree (tenant_id, tracker_id, source_key) WHERE (source_key <> ''::text);

CREATE INDEX tenant_tracker_task_links_task ON public.tenant_tracker_task_links USING btree (tenant_id, task_id);

CREATE UNIQUE INDEX tenant_tracker_task_links_unique ON public.tenant_tracker_task_links USING btree (tenant_id, tracker_id, row_id, column_id, task_id);

CREATE UNIQUE INDEX tenant_tracker_templates_key ON public.tenant_tracker_templates USING btree (tenant_id, template_key) WHERE (template_key <> ''::text);

CREATE INDEX tenant_trackers_recent ON public.tenant_trackers USING btree (tenant_id, updated_at DESC);

CREATE INDEX user_communications_owner_recent ON public.user_communications USING btree (tenant_id, owner_user_id, received_at DESC);

CREATE INDEX user_communications_source_labels_idx ON public.user_communications USING gin (source_labels);

CREATE INDEX user_communications_unread ON public.user_communications USING btree (tenant_id, owner_user_id, source) WHERE (read_at IS NULL);

CREATE INDEX user_github_issues_owner_recent ON public.user_github_issues USING btree (tenant_id, owner_user_id, github_user_id, updated_at DESC);

CREATE INDEX user_gitlab_issues_owner_recent ON public.user_gitlab_issues USING btree (tenant_id, owner_user_id, instance_url, gitlab_user_id, updated_at DESC);


-- ----------------------------------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------------------------------

CREATE TRIGGER tracker_state_touch_updated_at BEFORE UPDATE ON public.tracker_state FOR EACH ROW EXECUTE FUNCTION public.touch_tracker_state_updated_at();


-- ----------------------------------------------------------------------------------------------------
-- Foreign keys
-- ----------------------------------------------------------------------------------------------------

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT activity_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.data_migration_runs
    ADD CONSTRAINT data_migration_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_attachments
    ADD CONSTRAINT document_attachments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.drf_error_logs
    ADD CONSTRAINT drf_error_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.drf_error_logs
    ADD CONSTRAINT drf_error_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.gmail_accounts
    ADD CONSTRAINT gmail_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.google_calendar_accounts
    ADD CONSTRAINT google_calendar_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.google_calendar_connections
    ADD CONSTRAINT google_calendar_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.google_calendar_accounts(tenant_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.google_calendar_connections
    ADD CONSTRAINT google_calendar_connections_user_id_tenant_id_fkey FOREIGN KEY (user_id, tenant_id) REFERENCES public.app_users(id, organization_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.planner_activities
    ADD CONSTRAINT planner_activities_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.task_statuses
    ADD CONSTRAINT task_statuses_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.tenant_ai_agents
    ADD CONSTRAINT tenant_ai_agents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_dochub_accounts
    ADD CONSTRAINT tenant_dochub_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_dochub_documents
    ADD CONSTRAINT tenant_dochub_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_drive_accounts
    ADD CONSTRAINT tenant_drive_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_email_templates
    ADD CONSTRAINT tenant_email_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_integrations
    ADD CONSTRAINT tenant_integrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_reports
    ADD CONSTRAINT tenant_reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_state
    ADD CONSTRAINT tenant_state_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_templates
    ADD CONSTRAINT tenant_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_tracker_changes
    ADD CONSTRAINT tenant_tracker_changes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_tracker_rows
    ADD CONSTRAINT tenant_tracker_rows_tenant_id_tracker_id_fkey FOREIGN KEY (tenant_id, tracker_id) REFERENCES public.tenant_trackers(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_tracker_sources
    ADD CONSTRAINT tenant_tracker_sources_tenant_id_tracker_id_fkey FOREIGN KEY (tenant_id, tracker_id) REFERENCES public.tenant_trackers(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_tracker_task_links
    ADD CONSTRAINT tenant_tracker_task_links_tenant_id_tracker_id_fkey FOREIGN KEY (tenant_id, tracker_id) REFERENCES public.tenant_trackers(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_tracker_templates
    ADD CONSTRAINT tenant_tracker_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_trackers
    ADD CONSTRAINT tenant_trackers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_communication_settings
    ADD CONSTRAINT user_communication_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_communication_settings
    ADD CONSTRAINT user_communication_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_communications
    ADD CONSTRAINT user_communications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_communications
    ADD CONSTRAINT user_communications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_email_signatures
    ADD CONSTRAINT user_email_signatures_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_github_connections
    ADD CONSTRAINT user_github_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_github_connections
    ADD CONSTRAINT user_github_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_github_issues
    ADD CONSTRAINT user_github_issues_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_github_issues
    ADD CONSTRAINT user_github_issues_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_gitlab_connections
    ADD CONSTRAINT user_gitlab_connections_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_gitlab_connections
    ADD CONSTRAINT user_gitlab_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_gitlab_issues
    ADD CONSTRAINT user_gitlab_issues_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_gitlab_issues
    ADD CONSTRAINT user_gitlab_issues_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- ----------------------------------------------------------------------------------------------------
-- Starting sign-ins
-- ----------------------------------------------------------------------------------------------------

-- The first account, BXI-Core, with every module.
INSERT INTO public.organizations (id, name, slug, status, enabled_modules)
VALUES ('00000000-0000-0000-0000-000000000001', 'BXI-Core', 'bxi-core', 'Active', '["action","clients","projects","inbox","items","documents","requirements","trackers","reports","explorer","ai","settings"]'::jsonb);

-- Internal Admin (Account: internal_admin, Username: admin). Password: INTERNAL_ADMIN_BOOTSTRAP_PASSWORD, once.
INSERT INTO public.platform_users (id, account_key, username, password_hash, name, status, must_change_password)
VALUES ('00000000-0000-0000-0000-000000000100', 'internal_admin', 'admin', '__BOOTSTRAP_REQUIRED__',
        'Internal Administrator', 'Active', true);

-- BXI-Core administrator (Account: BXI-Core, Username: Admin). Password: BXI_CORE_BOOTSTRAP_PASSWORD, once.
INSERT INTO public.app_users (id, organization_id, username, password_hash, name, role, modules, status, is_platform_admin)
VALUES ('admin', '00000000-0000-0000-0000-000000000001', 'Admin', '__BOOTSTRAP_REQUIRED__', 'Administrator',
        'Administrator', '["action","clients","projects","inbox","items","documents","requirements","trackers","reports","explorer","ai","settings"]'::jsonb, 'Active', false);

commit;

select 'BA Client Ops Tracker database ready' as result, 36 as schema_version;
