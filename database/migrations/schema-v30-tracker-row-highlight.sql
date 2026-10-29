-- Apply once to databases at schema v29 (Supabase or Northflank PostgreSQL).
-- Trackers: a row can be given a highlight colour that everyone sees (yellow, green, blue…). Nothing else changes.
-- Without it, the tracker works and rows cannot be highlighted.
begin;
alter table public.tenant_tracker_rows add column if not exists highlight text not null default '';
notify pgrst, 'reload schema';
commit;
