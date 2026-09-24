-- v0.6.37: dedicated per-tenant AI agents. Non-destructive and rerunnable.
begin;

create table if not exists public.tenant_ai_agents (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  agent_id text not null check (agent_id in ('ba_assistant', 'document')),
  provider text not null check (provider in ('gemini', 'openai', 'anthropic', 'deepseek')),
  model text not null check (length(model) between 1 and 100),
  encrypted_secret text not null,
  secret_suffix text not null check (length(secret_suffix) = 4),
  is_enabled boolean not null default true,
  connection_status text not null default 'untested' check (connection_status in ('untested','verified','failed')),
  last_tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, agent_id)
);

alter table public.tenant_ai_agents enable row level security;
revoke all on public.tenant_ai_agents from public, anon, authenticated;
grant all on public.tenant_ai_agents to service_role;

commit;
