-- Schema v46: saves write only the records that changed.
--
-- Until now every save rewrote every row of the record tables (clients, projects, tasks, inquiries, activity,
-- planner, statuses, settings), so a one-field edit cost as much as the whole workspace. save_tenant_changes_v1 takes
-- only the rows that changed and the ids removed, under the same lock and revision check as save_tenant_state_v16.
-- Users (app_users) are still written whole. If a table's rows turn out to be out of step with the workspace (written
-- elsewhere), nothing is saved and the server saves in full instead, which puts them right.
--
-- Run once on every existing database before or after deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v46-changed-record-saves.sql
--
-- Safe to run again. Until it is run, saves work as before (every row rewritten); the server notices within ten
-- minutes of running it, without a restart.

begin;

CREATE OR REPLACE FUNCTION public.save_tenant_changes_v1(p_organization_id uuid, p_state jsonb, p_expected_updated_at timestamp with time zone, p_changes jsonb, p_counts jsonb, p_audit_entries jsonb DEFAULT '[]'::jsonb, p_actor_id text DEFAULT NULL::text, p_reason text DEFAULT 'tracker-save'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
-- Like save_tenant_state_v16, but writes only the record rows that changed: p_changes holds, per table, the rows to
-- add or update ("upsert") and the ids to remove ("remove"); "replace": true writes the table whole, as v6 does.
-- p_counts holds how many live rows each changed table must have afterwards. When a table does not match, its rows
-- were written elsewhere: nothing is saved (errcode BA046) and the server saves in full instead, which repairs it.
declare
  tenant_status text;
  current_updated_at timestamptz;
  table_name text;
  collection_name text;
  change jsonb;
  row_data jsonb;
  ids text[];
  removed text[];
  column_names text;
  update_columns text;
  requested integer;
  written integer;
  live integer;
  foreign_id boolean;
  counts jsonb := '{}'::jsonb;
  saved_at timestamptz := clock_timestamp();
  supported_tables text[] := array['clients','projects','tasks','inquiries','activity_logs','planner_activities','app_users','task_statuses','app_settings'];
begin
  if jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'A tracker data object is required.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or jsonb_typeof(p_counts) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_changes) key where not (key = any(supported_tables))) then
    raise exception 'A valid list of record changes is required.' using errcode = '22023';
  end if;

  -- The same lock and revision check as v16 and v6.
  select status into tenant_status from public.organizations
  where id = p_organization_id and deleted_at is null for update;
  if not found or tenant_status <> 'Active' then
    raise exception 'The workspace is unavailable.' using errcode = '42501';
  end if;
  select updated_at into current_updated_at from public.tenant_state where organization_id = p_organization_id;
  if current_updated_at is distinct from p_expected_updated_at then
    raise exception 'This workspace changed while saving. Reload and reapply your change; nothing was overwritten.' using errcode = '40001';
  end if;

  -- Validate the JSON snapshot before any write, as v6 does.
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

  foreach table_name in array supported_tables loop
    change := p_changes->table_name;
    continue when change is null;
    row_data := coalesce(change->'upsert', '[]'::jsonb);
    if jsonb_typeof(change) <> 'object' or jsonb_typeof(row_data) <> 'array'
       or jsonb_typeof(coalesce(change->'remove', '[]'::jsonb)) <> 'array' then
      raise exception 'Invalid record changes.' using errcode = '22023';
    end if;
    requested := jsonb_array_length(row_data);
    select coalesce(array_agg(entry->>'id'), array[]::text[]) into ids from jsonb_array_elements(row_data) entry;
    if cardinality(ids) <> (select count(distinct id) from unnest(ids) id) or exists (select 1 from unnest(ids) id where coalesce(id,'') = '') then
      raise exception 'Duplicate record IDs are not allowed.' using errcode = '22023';
    end if;

    if requested > 0 then
      -- Only the privileged Node server can invoke this RPC. Its fixed record mappings select application columns;
      -- tenant ownership is assigned here.
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
      if written <> requested then
        raise exception 'A record ID belongs to another workspace. No changes were saved.' using errcode = '42501';
      end if;
    end if;

    if coalesce((change->>'replace')::boolean, false) then
      execute format('update public.%I set deleted_at=$3,updated_at=$3 where organization_id=$2 and deleted_at is null and not (id = any($1))', table_name)
        using ids, p_organization_id, saved_at;
    else
      select coalesce(array_agg(value), array[]::text[]) into removed
        from jsonb_array_elements_text(coalesce(change->'remove', '[]'::jsonb)) value;
      if removed && ids then
        raise exception 'A record cannot be saved and removed at once.' using errcode = '22023';
      end if;
      if cardinality(removed) > 0 then
        execute format('update public.%I set deleted_at=$3,updated_at=$3 where organization_id=$2 and deleted_at is null and id = any($1)', table_name)
          using removed, p_organization_id, saved_at;
      end if;
    end if;

    if p_counts ? table_name then
      execute format('select count(*) from public.%I where organization_id=$1 and deleted_at is null', table_name)
        into live using p_organization_id;
      if live <> (p_counts->>table_name)::integer then
        raise exception 'The % rows are out of step with the workspace. Save every record instead.', table_name using errcode = 'BA046';
      end if;
    end if;
    counts := counts || jsonb_build_object(table_name, requested);
  end loop;

  if counts <> '{}'::jsonb then
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

  return jsonb_build_object('ready',true,'syncedAt',saved_at,'counts',counts,'changedRows',true);
end;
$_$;

commit;

select 'BA Client Ops Tracker database ready' as result, 46 as schema_version;
