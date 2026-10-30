-- Apply once to databases at schema v33 (Supabase or Northflank PostgreSQL).
-- Trackers: templates the account keeps, so the columns new trackers start with can be changed. Anyone with Trackers
-- may keep private templates; only Administrators share them, change or hide the built-in ones (their copy is kept
-- under the built-in template's key) and delete shared ones. Trackers already made keep their own columns. Without it,
-- New tracker offers the built-in templates as before.
begin;
create table if not exists public.tenant_tracker_templates (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  id uuid not null,
  name text not null check (length(name) between 1 and 80),
  about text not null default '',
  columns jsonb not null default '[]'::jsonb,
  shared boolean not null default false,
  hidden boolean not null default false,
  template_key text not null default '',
  revision integer not null default 1,
  created_by text not null default '',
  created_by_name text not null default '',
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create unique index if not exists tenant_tracker_templates_key
  on public.tenant_tracker_templates(tenant_id, template_key) where template_key <> '';

-- Supabase only: lock the table to the service role, as for the other private tables.
-- Plain PostgreSQL (Northflank) has no anon/service_role, and enabling row level security
-- there would block the app's database user, so it is skipped.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_tracker_templates enable row level security';
    execute 'revoke all on public.tenant_tracker_templates from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_tracker_templates to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
