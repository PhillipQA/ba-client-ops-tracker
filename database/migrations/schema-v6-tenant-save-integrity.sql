-- BA Client Ops Tracker v0.6.3: atomic tenant saves and ownership checks.
-- Run AFTER schema-v5-security-hardening.sql, BEFORE starting v0.6.3.
-- Additive migration: existing records and credentials are not rewritten.
begin;

create or replace function public.save_tenant_state_v6(
  p_organization_id uuid,
  p_state jsonb,
  p_records jsonb default null,
  p_audit_entries jsonb default '[]'::jsonb,
  p_actor_id text default null,
  p_reason text default 'tracker-save'
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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
$$;

-- This function accepts trusted server payloads. Never expose it to browsers.
revoke all on function public.save_tenant_state_v6(uuid,jsonb,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.save_tenant_state_v6(uuid,jsonb,jsonb,jsonb,text,text) to service_role;

notify pgrst, 'reload schema';
commit;
