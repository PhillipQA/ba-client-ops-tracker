-- v0.6.5: run after schema-v7-password-recovery.sql. Non-destructive and rerunnable.
begin;
create table if not exists public.tenant_integrations (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  integration_type text not null check (integration_type in ('discord', 'openai')),
  encrypted_secret text not null,
  secret_suffix text not null check (length(secret_suffix) = 4),
  provider_identity text,
  config_json jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  connection_status text not null default 'untested' check (connection_status in ('untested','verified','failed')),
  last_tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, integration_type)
);
create unique index if not exists tenant_discord_bot_unique on public.tenant_integrations(provider_identity)
  where integration_type = 'discord' and provider_identity is not null;
alter table public.tenant_integrations enable row level security;
revoke all on public.tenant_integrations from public, anon, authenticated;
grant all on public.tenant_integrations to service_role;
create table if not exists public.tenant_templates (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  name text not null,
  content_base64 text not null check (octet_length(content_base64) <= 7340032),
  updated_at timestamptz not null default now()
);
alter table public.tenant_templates enable row level security;
revoke all on public.tenant_templates from public, anon, authenticated;
grant all on public.tenant_templates to service_role;
commit;
