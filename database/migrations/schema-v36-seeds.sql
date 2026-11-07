-- Schema v36: each person's own Seeds API key (Seeds page › Sync › Connect your Seeds).
-- Run once on an existing database before people connect Seeds. Safe to run again.
begin;

create table if not exists public.user_seeds_connections (
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id text not null references public.app_users(id) on delete cascade,
    encrypted_key text not null,
    key_suffix text not null,
    connection_status text default 'untested' not null,
    last_synced_at timestamp with time zone,
    updated_at timestamp with time zone default now() not null,
    primary key (tenant_id, user_id)
);

commit;

select 'Seeds connections ready' as result, 36 as schema_version;
