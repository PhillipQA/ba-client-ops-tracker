-- Apply once to databases at schema v31 (Supabase or Northflank PostgreSQL).
-- Work Hub: each received email and Discord message can be read or unread, so Work Hub shows how many are unread.
-- Messages already in Work Hub are marked read, so the count starts from what arrives next. New Gmail mail is unread
-- while Gmail has it unread; Discord messages arrive unread. Opening a message marks it read. Without it, Work Hub
-- works as before and shows no unread count.
begin;
alter table public.user_communications add column if not exists read_at timestamptz;
update public.user_communications set read_at = coalesce(created_at, now()) where read_at is null;
create index if not exists user_communications_unread
  on public.user_communications(tenant_id, owner_user_id, source)
  where read_at is null;
notify pgrst, 'reload schema';
commit;
