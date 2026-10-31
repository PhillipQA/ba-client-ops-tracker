# Server structure

The Express backend is grouped by responsibility. Each group of routes lives in its own module and is registered from `index.ts`.

- `index.ts` — creates the app, adds middleware and registers every route group, in order. Nothing else.
- `core/` — what most routes share:
  - `env.ts` loads `.env.local` and `.env` before any other module reads `process.env`;
  - `config.ts` (port, production mode, project root, time zone), `database.ts` (the PostgreSQL client, `db`), `constants.ts`, `services.ts` (integration settings and AI agents);
  - `auth.ts` — sessions, passwords, `requireAuth`, `requireTenantWorkspace`, `moduleAllowed`;
  - `tenant-state.ts` — loading, saving and normalising each organisation's workspace.
- `auth/` — sign-in, sign-out and password-recovery routes, rate limits, HTTP auth transport, recovery email.
- `workspace/` — the workspace store, its revision, notifications and data-architecture checks.
- `accounts/` — tenant user/account administration routes.
- `ai/` — AI BA assistant routes, suggestion clean-up, AI Agent Manager and tenant AI execution.
- `documents/` — BRD, FSD, DRF, Test Case and Sign-Off generation/export routes.
- `integrations/` — Gmail, Google Drive and Calendar, Discord, Git providers, DocHub, email templates and AI credentials.
- `trackers/` — tracker, row, column, task-link and Google Sheet routes.
- `tasks/` — task comments, time entries and evidence files.
- `platform/` — Internal Admin, platform settings and authorization, static site serving.
- `services/` — shared workspace rules such as notifications, follow-up rollover and save guards.

A route module exports `register…Routes(app)` and imports what it needs from `core/`; older modules take their dependencies as a second argument. The repository-root `server.ts` is intentionally kept as a tiny stable entry point for existing hosts and npm commands.
