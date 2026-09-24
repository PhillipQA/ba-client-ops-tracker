-- BA Client Ops Tracker - single-workspace cloud state
-- Run this in Supabase SQL Editor once.

create table if not exists public.tracker_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Direct browser access is intentionally disabled. The app's Node server uses
-- the Supabase service-role key and is the only component that reads/writes this table.
alter table public.tracker_state enable row level security;
revoke all on table public.tracker_state from anon, authenticated;

create or replace function public.touch_tracker_state_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tracker_state_touch_updated_at on public.tracker_state;
create trigger tracker_state_touch_updated_at
before update on public.tracker_state
for each row execute function public.touch_tracker_state_updated_at();
