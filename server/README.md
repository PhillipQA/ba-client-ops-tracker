# Server structure

The Express backend is grouped by responsibility so backend code does not crowd the repository root.

- `accounts/` — tenant user/account administration routes.
- `ai/` — AI Agent Manager and tenant AI execution.
- `auth/` — HTTP authentication transport and password-recovery email.
- `documents/` — FSD, Test Case and Sign-Off generation/export routes.
- `integrations/` — tenant integrations such as DocHub, Google Calendar and AI credentials.
- `platform/` — Internal Admin / platform-level settings and authorization.
- `services/` — shared workspace services such as notifications, follow-up rollover and save guards.
- `index.ts` — main Express application implementation.

The repository-root `server.ts` is intentionally kept as a tiny stable entry point for existing Render and npm commands.
