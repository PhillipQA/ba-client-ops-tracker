-- Apply once to existing v0.6.86 databases (Supabase or Northflank PostgreSQL).
-- One shared Google Drive per account for saving Gmail attachments to task folders.
-- File contents are never stored here: only the encrypted Drive connection, the
-- app-created root folder and the folder id used for each client, project and task.
begin;
create table if not exists public.tenant_drive_accounts (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  drive_email text not null,
  encrypted_refresh_token text not null,
  gmail_config_revision uuid not null,
  root_folder_id text,
  folders jsonb not null default '{}'::jsonb,
  connected_by text,
  updated_at timestamptz not null default now()
);
-- Private list of every task created from a message. The shared task never
-- stores the private message id; this column lets the owner pick among them.
alter table public.user_communications add column if not exists linked_task_ids text[] not null default '{}'::text[];
update public.user_communications set linked_task_ids = array[linked_task_id]
  where linked_task_id is not null and linked_task_id <> '' and cardinality(linked_task_ids) = 0;
-- Supabase only: lock the table to the service role, as for the other private tables.
-- Plain PostgreSQL (Northflank) has no anon/service_role, and enabling row level
-- security there would block the app's database user, so it is skipped.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_drive_accounts enable row level security';
    execute 'revoke all on public.tenant_drive_accounts from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_drive_accounts to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
