-- Schema v47: sign-ins are kept in the database.
--
-- Until now sessions lived only in the server's memory, so every restart or deploy signed everyone out, and a second
-- server instance did not know the first one's sign-ins. public.app_sessions keeps them:
--
--   token_hash     SHA-256 of the session token (the token itself is never stored; a copy of this table signs no one in)
--   user_id, organization_id, account_type   whose session it is
--   user_data      the signed-in user as the server uses it (no password hash)
--   flags          marks such as a Seeds exception sign-in
--   created_at, last_seen_at, expires_at     the 8-hour and idle limits, enforced by the server as before
--
-- Run once on every existing database, before or after deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v47-sessions.sql
--
-- Safe to run again. Until it is run, sessions stay in memory as before; the server looks for the table again every
-- ten minutes, so no restart is needed.

begin;

CREATE TABLE IF NOT EXISTS public.app_sessions (
    token_hash text NOT NULL PRIMARY KEY,
    user_id text NOT NULL,
    organization_id text,
    account_type text DEFAULT 'tenant'::text NOT NULL,
    user_data jsonb NOT NULL,
    flags jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT app_sessions_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON public.app_sessions USING btree (user_id);

CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON public.app_sessions USING btree (expires_at);

commit;

select 'BA Client Ops Tracker database ready' as result, 47 as schema_version;
