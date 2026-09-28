-- v0.6.56. Run after schema-v15. Atomic optimistic concurrency across servers.
begin;
create or replace function public.save_tenant_state_v16(
  p_organization_id uuid,
  p_state jsonb,
  p_expected_updated_at timestamptz,
  p_records jsonb default null,
  p_audit_entries jsonb default '[]'::jsonb,
  p_actor_id text default null,
  p_reason text default 'tracker-save'
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_updated_at timestamptz;
begin
  -- Use the same lock as v6, including for a tenant's first snapshot.
  perform 1 from public.organizations where id = p_organization_id for update;
  select updated_at into current_updated_at from public.tenant_state where organization_id = p_organization_id;
  if current_updated_at is distinct from p_expected_updated_at then
    raise exception 'This workspace changed while saving. Reload and reapply your change; nothing was overwritten.' using errcode = '40001';
  end if;
  return public.save_tenant_state_v6(p_organization_id, p_state, p_records, p_audit_entries, p_actor_id, p_reason);
end;
$$;
revoke all on function public.save_tenant_state_v16(uuid,jsonb,timestamptz,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.save_tenant_state_v16(uuid,jsonb,timestamptz,jsonb,jsonb,text,text) to service_role;
alter table public.user_communication_settings add column if not exists gmail_sync_state jsonb not null default '{}'::jsonb;
alter table public.user_communications add column if not exists source_labels text[] not null default '{}'::text[];
update public.user_communications set source_labels = array[source_label] where source_label is not null and source_label <> '' and cardinality(source_labels) = 0;
create index if not exists user_communications_source_labels_idx on public.user_communications using gin(source_labels);
notify pgrst, 'reload schema';
commit;
