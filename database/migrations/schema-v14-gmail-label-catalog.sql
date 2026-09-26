-- Apply after schema-v13. Store label names with each user's private Gmail settings.
begin;
alter table public.user_communication_settings
  add column if not exists gmail_label_catalog jsonb not null default '[]'::jsonb;
commit;
