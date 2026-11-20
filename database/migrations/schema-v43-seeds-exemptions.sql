-- Schema v43: Seeds exceptions.
--
-- Once Seeds is on, only its active employees sign in. Until now every Administrator was let in regardless; that
-- automatic pass is removed. Instead, Internal Admin can let one user sign in with a password without Seeds:
--
--   app_users.seeds_exempt   true: this user may sign in with a password even when Seeds does not list them.
--                            Sign in with Google always needs Seeds. Set only from Internal Admin.
--
-- So nobody is locked out by the change, the first run turns the exception on for each Administrator who is not in
-- their account's Seeds directory today (Seeds on, with a directory). Everyone else starts without it.
-- Until this is run, Administrators keep the old automatic pass and Internal Admin cannot set exceptions.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v43-seeds-exemptions.sql
--
-- Safe to run again: the Administrators are granted only when the column is first added, so an exception Internal
-- Admin later turns off stays off.

begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'app_users' and column_name = 'seeds_exempt'
  ) then
    alter table public.app_users add column seeds_exempt boolean default false not null;

    update public.app_users u
       set seeds_exempt = true, updated_at = now()
      from public.tenant_state t
     where t.organization_id = u.organization_id
       and u.deleted_at is null
       and u.role = 'Administrator'
       and t.data->'seeds'->>'connected' = 'true'
       and jsonb_typeof(t.data->'seeds'->'people') = 'array'
       and exists (
         select 1 from jsonb_array_elements(t.data->'seeds'->'people') p
          where btrim(coalesce(p->>'email', '')) <> ''
       )
       and not exists (
         select 1 from jsonb_array_elements(t.data->'seeds'->'people') p
          where lower(btrim(coalesce(p->>'email', ''))) = lower(btrim(u.email))
            and btrim(u.email) <> ''
       );
  end if;
end
$$;

commit;

select 'BA Client Ops Tracker database ready' as result, 43 as schema_version;
