-- BA Client Ops Tracker - Multi-tenant Architecture v3 (BXI-Core)
-- Run AFTER schema.sql and schema-v2.sql.
-- This keeps tracker_state as a legacy fallback, creates BXI-Core as the first tenant,
-- and moves the active workspace state to tenant_state without deleting existing data.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'Active' check (status in ('Active','Suspended')),
  enabled_modules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.tenant_state (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stable ID for the original workspace so existing data can be migrated deterministically.
insert into public.organizations (id, name, slug, status, enabled_modules)
values (
  '00000000-0000-0000-0000-000000000001',
  'BXI-Core',
  'bxi-core',
  'Active',
  '["action","clients","projects","inbox","items","documents","reports","ai","settings"]'::jsonb
)
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  enabled_modules = excluded.enabled_modules,
  updated_at = now();

-- Preserve the existing single-workspace JSON state as the BXI-Core tenant state.
insert into public.tenant_state (organization_id, data, updated_at)
select '00000000-0000-0000-0000-000000000001', data, coalesce(updated_at, now())
from public.tracker_state
where id = 'main'
on conflict (organization_id) do update set
  data = excluded.data,
  updated_at = excluded.updated_at;

-- Tenant-scope every normalized table. Columns remain nullable during migration so old rows can be assigned safely.
alter table public.clients add column if not exists organization_id uuid references public.organizations(id);
alter table public.projects add column if not exists organization_id uuid references public.organizations(id);
alter table public.tasks add column if not exists organization_id uuid references public.organizations(id);
alter table public.inquiries add column if not exists organization_id uuid references public.organizations(id);
alter table public.activity_logs add column if not exists organization_id uuid references public.organizations(id);
alter table public.planner_activities add column if not exists organization_id uuid references public.organizations(id);
alter table public.app_users add column if not exists organization_id uuid references public.organizations(id);
alter table public.app_users add column if not exists is_platform_admin boolean not null default false;
alter table public.app_users add column if not exists last_login_at timestamptz;
alter table public.task_statuses add column if not exists organization_id uuid references public.organizations(id);
alter table public.app_settings add column if not exists organization_id uuid references public.organizations(id);
alter table public.audit_logs add column if not exists organization_id uuid references public.organizations(id);
alter table public.data_migration_runs add column if not exists organization_id uuid references public.organizations(id);
alter table public.documents add column if not exists organization_id uuid references public.organizations(id);
alter table public.document_versions add column if not exists organization_id uuid references public.organizations(id);
alter table public.document_attachments add column if not exists organization_id uuid references public.organizations(id);

-- Existing normalized rows all belong to the original BXI-Core workspace.
update public.clients set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.projects set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.tasks set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.inquiries set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.activity_logs set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.planner_activities set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.app_users set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.task_statuses set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.app_settings set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.audit_logs set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.data_migration_runs set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.documents set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.document_versions set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update public.document_attachments set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;

-- If app_users was not populated yet, recover user records from tracker_state/tenant_state.
insert into public.app_users (
  id, organization_id, username, password_hash, name, email, phone, role, modules, status,
  created_on, raw_data, is_platform_admin, updated_at, deleted_at
)
select
  account->>'id',
  '00000000-0000-0000-0000-000000000001',
  coalesce(account->>'username',''),
  coalesce(account->>'passwordHash',''),
  coalesce(account->>'name',''),
  coalesce(account->>'email',''),
  coalesce(account->>'phone',''),
  coalesce(account->>'role','Contributor'),
  coalesce(account->'modules','[]'::jsonb),
  coalesce(account->>'status','Active'),
  case when coalesce(account->>'createdAt','') ~ '^\d{4}-\d{2}-\d{2}$' then (account->>'createdAt')::date else current_date end,
  account - 'passwordHash',
  lower(coalesce(account->>'username','')) = 'admin',
  now(),
  null
from public.tenant_state state
cross join lateral jsonb_array_elements(coalesce(state.data->'accounts','[]'::jsonb)) account
where state.organization_id = '00000000-0000-0000-0000-000000000001'
  and coalesce(account->>'id','') <> ''
on conflict (id) do update set
  organization_id = excluded.organization_id,
  username = excluded.username,
  password_hash = case when excluded.password_hash <> '' then excluded.password_hash else public.app_users.password_hash end,
  name = excluded.name,
  email = excluded.email,
  phone = excluded.phone,
  role = excluded.role,
  modules = excluded.modules,
  status = excluded.status,
  raw_data = excluded.raw_data,
  is_platform_admin = public.app_users.is_platform_admin or excluded.is_platform_admin,
  updated_at = now(),
  deleted_at = null;

-- The original Admin account becomes the BXI-Core platform administrator.
update public.app_users
set is_platform_admin = true, organization_id = '00000000-0000-0000-0000-000000000001', updated_at = now()
where lower(username) = 'admin' and deleted_at is null;

-- Tenant-aware indexes.
create index if not exists clients_org_idx on public.clients(organization_id);
create index if not exists projects_org_idx on public.projects(organization_id);
create index if not exists tasks_org_idx on public.tasks(organization_id);
create index if not exists inquiries_org_idx on public.inquiries(organization_id);
create index if not exists activity_logs_org_idx on public.activity_logs(organization_id);
create index if not exists planner_activities_org_idx on public.planner_activities(organization_id);
create index if not exists app_users_org_idx on public.app_users(organization_id);
create index if not exists task_statuses_org_idx on public.task_statuses(organization_id);
create index if not exists app_settings_org_idx on public.app_settings(organization_id);
create index if not exists audit_logs_org_idx on public.audit_logs(organization_id, changed_at desc);
create index if not exists migration_runs_org_idx on public.data_migration_runs(organization_id, started_at desc);
create index if not exists documents_org_idx on public.documents(organization_id);
create index if not exists document_versions_org_idx on public.document_versions(organization_id);
create index if not exists document_attachments_org_idx on public.document_attachments(organization_id);

-- Keep direct browser access locked down. The Node server continues to use the service role.
alter table public.organizations enable row level security;
alter table public.tenant_state enable row level security;
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.tenant_state from anon, authenticated;

-- Future-proof RLS helper for a later Supabase Auth phase. Without an organization_id JWT claim,
-- authenticated browser clients still see no tenant rows. The service role bypasses RLS.
create or replace function public.request_organization_id()
returns uuid
language plpgsql
stable
as $$
declare
  claims jsonb;
  value text;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    value := claims->>'organization_id';
    if value is null or value = '' then return null; end if;
    return value::uuid;
  exception when others then
    return null;
  end;
end;
$$;

-- Do not create permissive policies for app_users/platform data yet; the server is authoritative.
-- Tenant tables remain RLS-enabled and direct anon/authenticated grants remain revoked.

-- After assigning all legacy rows, organization ownership becomes mandatory.
alter table public.clients alter column organization_id set not null;
alter table public.projects alter column organization_id set not null;
alter table public.tasks alter column organization_id set not null;
alter table public.inquiries alter column organization_id set not null;
alter table public.activity_logs alter column organization_id set not null;
alter table public.planner_activities alter column organization_id set not null;
alter table public.app_users alter column organization_id set not null;
alter table public.task_statuses alter column organization_id set not null;
alter table public.app_settings alter column organization_id set not null;
alter table public.audit_logs alter column organization_id set not null;
alter table public.data_migration_runs alter column organization_id set not null;
alter table public.documents alter column organization_id set not null;
alter table public.document_versions alter column organization_id set not null;
alter table public.document_attachments alter column organization_id set not null;

-- Tenant isolation policies for a future Supabase Auth/JWT path. Current app traffic still goes
-- through the Node server/service role, while anon/authenticated table grants remain revoked.
do $$
declare
  t text;
begin
  foreach t in array array['clients','projects','tasks','inquiries','activity_logs','planner_activities','app_users','task_statuses','app_settings','audit_logs','data_migration_runs','documents','document_versions','document_attachments','tenant_state']
  loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I for all using (organization_id = public.request_organization_id()) with check (organization_id = public.request_organization_id())', t);
  end loop;
end $$;

drop policy if exists organization_self on public.organizations;
create policy organization_self on public.organizations
for select using (id = public.request_organization_id());
