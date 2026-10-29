-- Apply once to databases at schema v28 (Supabase or Northflank PostgreSQL).
-- Trackers: the Timeline view's settings (which columns are Start, End, % done, Phase…, and the zoom) are kept on the
-- tracker, so everyone who opens it sees the same timeline. Nothing else changes. Without it, the settings are kept
-- in each person's browser instead.
begin;
alter table public.tenant_trackers add column if not exists timeline jsonb not null default '{}'::jsonb;
notify pgrst, 'reload schema';
commit;
