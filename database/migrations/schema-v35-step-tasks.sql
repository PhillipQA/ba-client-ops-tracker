-- Apply once to databases at schema v34 (Supabase or Northflank PostgreSQL).
-- Trackers: a switch that makes each row a task and each Checkbox column a subtask of it, on a tracker and on a
-- template. Site rollout trackers have it on unless someone switches it off; templates saved from such a tracker keep
-- it. Without it, only trackers made from the built-in Site rollout template make these tasks.
begin;
alter table public.tenant_trackers add column if not exists step_tasks boolean;
alter table public.tenant_tracker_templates add column if not exists step_tasks boolean;
notify pgrst, 'reload schema';
commit;
