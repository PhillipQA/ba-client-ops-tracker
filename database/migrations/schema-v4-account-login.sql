-- BA Client Ops Tracker - Account-aware login + Internal Admin identity (v4)
-- Run AFTER schema-v3-multitenant.sql.
-- This separates the platform control-plane login from tenant users and allows
-- the same username (for example "admin") to exist in different tenant accounts.

create extension if not exists pgcrypto;

create table if not exists public.platform_users (
  id uuid primary key default gen_random_uuid(),
  account_key text not null default 'internal_admin',
  username text not null,
  password_hash text not null,
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  status text not null default 'Active' check (status in ('Active','Disabled')),
  must_change_password boolean not null default true,
  password_changed_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists platform_users_account_username_uidx
  on public.platform_users(lower(account_key), lower(username))
  where deleted_at is null;

-- BXI-Core control-plane bootstrap user.
-- No default password is stored in SQL. The server initializes this account from
-- INTERNAL_ADMIN_BOOTSTRAP_PASSWORD on the first successful secure bootstrap login.
insert into public.platform_users (
  id, account_key, username, password_hash, name, status, must_change_password
)
values (
  '00000000-0000-0000-0000-000000000100',
  'internal_admin',
  'admin',
  '__BOOTSTRAP_REQUIRED__',
  'Internal Administrator',
  'Active',
  true
)
on conflict (id) do update set
  account_key = excluded.account_key,
  username = excluded.username,
  name = excluded.name,
  status = 'Active',
  updated_at = now();

-- Platform administration is no longer represented by a tenant app_users row.
-- The existing BXI-Core Admin remains a normal Administrator inside BXI-Core.
update public.app_users
set is_platform_admin = false, updated_at = now()
where is_platform_admin = true;

-- v2 originally made usernames globally unique. Account-aware login scopes them
-- to an organization, so Tenant A/admin and Tenant B/admin can coexist.
drop index if exists public.app_users_username_lower_uidx;
create unique index if not exists app_users_org_username_lower_uidx
  on public.app_users(organization_id, lower(username))
  where deleted_at is null;

-- Fresh-install safety: keep the original BXI-Core workspace usable even when
-- no tenant user existed before the multi-tenant migration. Existing data/users are untouched.
insert into public.app_users (
  id, organization_id, username, password_hash, name, email, phone, role, modules, status,
  created_on, raw_data, is_platform_admin, updated_at, deleted_at
)
select
  'admin',
  '00000000-0000-0000-0000-000000000001',
  'Admin',
  '__BOOTSTRAP_REQUIRED__',
  'Administrator', '', '', 'Administrator',
  '["action","clients","projects","inbox","items","documents","reports","ai","settings"]'::jsonb,
  'Active', current_date,
  '{"id":"admin","username":"Admin","name":"Administrator","email":"","phone":"","role":"Administrator","modules":["action","clients","projects","inbox","items","documents","reports","ai","settings"],"status":"Active"}'::jsonb,
  false, now(), null
where not exists (
  select 1 from public.app_users
  where organization_id = '00000000-0000-0000-0000-000000000001'
    and lower(username) = 'admin'
    and deleted_at is null
)
on conflict (id) do nothing;

-- Lock the platform identity table away from direct browser clients.
alter table public.platform_users enable row level security;
revoke all on table public.platform_users from anon, authenticated;
