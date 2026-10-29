-- Apply once to databases at schema v30 (Supabase or Northflank PostgreSQL).
-- Reports: dashboards people build from widgets (number tiles, charts, tables, timelines), kept in folders, and the
-- templates new reports start from. A report, folder or template is private to the person who made it until it is
-- shared with the whole account; only Administrators share templates, and they can change, hide or reset the
-- suggested ones (their copy is kept with the suggested template's key). The widgets and filters are kept as one JSON
-- value; the numbers are worked out when a report is opened, so nothing else is copied. Without it, Reports says the
-- upgrade is missing.
begin;
create table if not exists public.tenant_reports (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  id uuid not null,
  kind text not null default 'report' check (kind in ('report', 'folder', 'template')),
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  folder_id text not null default '',
  shared boolean not null default false,
  position integer not null default 0,
  definition jsonb not null default '{}'::jsonb,
  template_key text not null default '',
  hidden boolean not null default false,
  revision integer not null default 1,
  created_by text not null default '',
  created_by_name text not null default '',
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists tenant_reports_by_owner on public.tenant_reports(tenant_id, created_by);

-- Supabase only: lock the table to the service role, as for the other private tables.
-- Plain PostgreSQL (Northflank) has no anon/service_role, and enabling row level security
-- there would block the app's database user, so it is skipped.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_reports enable row level security';
    execute 'revoke all on public.tenant_reports from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_reports to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
