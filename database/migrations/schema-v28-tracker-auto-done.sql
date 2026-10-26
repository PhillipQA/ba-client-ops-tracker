-- Apply once to databases at schema v27 (Supabase or Northflank PostgreSQL).
-- Trackers: a Checkbox or Choice column can mark a row done when its linked tasks are completed, and write that to
-- the connected Google Sheet. When a row's mark could not be written to the Sheet, the reason is kept on the row so
-- people can retry or dismiss it. Nothing else changes; the setting itself is stored with the tracker's columns.
begin;
alter table public.tenant_tracker_rows add column if not exists sheet_issue jsonb;
create index if not exists tenant_tracker_rows_sheet_issue on public.tenant_tracker_rows(tenant_id, tracker_id) where sheet_issue is not null;
notify pgrst, 'reload schema';
commit;
