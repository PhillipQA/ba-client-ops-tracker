-- BA Client Ops Tracker - Security hardening v5
-- Run AFTER schema-v4-account-login.sql.
-- This removes the known legacy "admin" bootstrap hash only when it is still unchanged.
-- Existing users with other SHA-256 hashes are left intact and are upgraded to bcrypt
-- automatically by the v0.6.2 server after their next successful login.

begin;

-- Internal Admin: replace the known default admin/admin hash with a bootstrap marker.
-- Set INTERNAL_ADMIN_BOOTSTRAP_PASSWORD (12+ characters) in Render before signing in.
update public.platform_users
set password_hash = '__BOOTSTRAP_REQUIRED__',
    must_change_password = true,
    updated_at = now()
where lower(account_key) = 'internal_admin'
  and lower(username) = 'admin'
  and password_hash = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
  and must_change_password = true
  and deleted_at is null;

-- BXI-Core tenant Admin: remove the known default admin/admin hash when unchanged.
-- Set BXI_CORE_BOOTSTRAP_PASSWORD (12+ characters) in Render before signing in.
update public.app_users
set password_hash = '__BOOTSTRAP_REQUIRED__',
    updated_at = now()
where organization_id = '00000000-0000-0000-0000-000000000001'
  and lower(username) = 'admin'
  and password_hash = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
  and deleted_at is null;

-- Keep BXI-Core tenant_state aligned so a later normalized sync cannot restore the old hash.
update public.tenant_state
set data = jsonb_set(
      data,
      '{accounts}',
      (
        select coalesce(jsonb_agg(
          case
            when lower(coalesce(account->>'username','')) = 'admin'
             and coalesce(account->>'passwordHash','') = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
            then jsonb_set(account, '{passwordHash}', to_jsonb('__BOOTSTRAP_REQUIRED__'::text), true)
            else account
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(coalesce(data->'accounts','[]'::jsonb)) account
      ),
      true
    ),
    updated_at = now()
where organization_id = '00000000-0000-0000-0000-000000000001';

-- Keep the legacy rollback snapshot aligned as well.
update public.tracker_state
set data = jsonb_set(
      data,
      '{accounts}',
      (
        select coalesce(jsonb_agg(
          case
            when lower(coalesce(account->>'username','')) = 'admin'
             and coalesce(account->>'passwordHash','') = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
            then jsonb_set(account, '{passwordHash}', to_jsonb('__BOOTSTRAP_REQUIRED__'::text), true)
            else account
          end
        ), '[]'::jsonb)
        from jsonb_array_elements(coalesce(data->'accounts','[]'::jsonb)) account
      ),
      true
    )
where id = 'main';

commit;
