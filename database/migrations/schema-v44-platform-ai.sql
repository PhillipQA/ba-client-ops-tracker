-- Schema v44: AI keys move to Internal Admin.
--
-- The BA Assistant and the Document Agent now use one key each, set by Internal Admin for every account:
--
--   platform_ai_agents   one row per agent (ba_assistant, document): provider, model and the encrypted key.
--
-- An account gets AI when Internal Admin has turned its AI module on (Internal Admin › the account › Modules).
-- The keys accounts saved before (tenant_ai_agents, and the old shared AI key in tenant_integrations) are no longer
-- used, and are left in place untouched; enter the keys again in Internal Admin › AI.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v44-platform-ai.sql
--
-- Safe to run again.

begin;

create table if not exists public.platform_ai_agents (
    agent_id text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    encrypted_secret text NOT NULL,
    secret_suffix text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_ai_agents_pkey PRIMARY KEY (agent_id),
    CONSTRAINT platform_ai_agents_agent_id_check CHECK ((agent_id = ANY (ARRAY['ba_assistant'::text, 'document'::text]))),
    CONSTRAINT platform_ai_agents_model_check CHECK (((length(model) >= 1) AND (length(model) <= 100))),
    CONSTRAINT platform_ai_agents_provider_check CHECK ((provider = ANY (ARRAY['gemini'::text, 'openai'::text, 'anthropic'::text, 'deepseek'::text]))),
    CONSTRAINT platform_ai_agents_secret_suffix_check CHECK ((length(secret_suffix) = 4))
);

commit;

select 'BA Client Ops Tracker database ready' as result, 44 as schema_version;
