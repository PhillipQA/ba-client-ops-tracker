-- v0.6.33. Additive, rerunnable migration; run after schema-v9-google-calendar.sql.
begin;
create table if not exists public.tenant_dochub_accounts (
 tenant_id uuid primary key references public.organizations(id) on delete cascade,
 encrypted_api_key text not null,
 key_suffix text not null,
 enabled boolean not null default true,
 encrypted_webhook_secret text,
 webhook_id text,
 webhook_url text,
 verified_at timestamptz,
 updated_at timestamptz not null default now()
);
create table if not exists public.tenant_dochub_documents (
 tenant_id uuid not null references public.organizations(id) on delete cascade,
 id uuid not null,
 document_id text,
 data jsonb not null,
 updated_at timestamptz not null default now(),
 primary key (tenant_id,id),
 unique (tenant_id,document_id)
);
create index if not exists tenant_dochub_documents_recent on public.tenant_dochub_documents(tenant_id,updated_at desc);
alter table public.tenant_dochub_accounts enable row level security;
alter table public.tenant_dochub_documents enable row level security;
revoke all on public.tenant_dochub_accounts, public.tenant_dochub_documents from public, anon, authenticated;
grant all on public.tenant_dochub_accounts, public.tenant_dochub_documents to service_role;
commit;
