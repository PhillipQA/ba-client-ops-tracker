# Deploy on a new server

Use this guide when changing the application host. For a first local installation, start with the [README](../../README.md#install-locally).

## 1. Choose the database path

| Situation | Action |
| --- | --- |
| Keep the existing Supabase database | Reuse its URL/service-role key. Do not run fresh setup. |
| Keep an existing prepared PostgreSQL database | Set `DATABASE_PROVIDER=postgres` and the application user's `DATABASE_URL`. Preserve the tracker schema and evidence table. |
| Start a separate new installation | Create an empty Supabase project and run [database/setup.sql](../../database/setup.sql) once. It reports schema version **21**. |
| Move existing Supabase data to Northflank | Follow the [PostgreSQL cutover guide](northflank-postgres-cutover.md) first. A new schema does not copy your existing data or evidence files. |

Preserve `TENANT_INTEGRATION_MASTER_KEY` whenever reusing data. Generate a new key only for an independent new installation.

## 2. Configure the host

Connect the repository/branch or upload a complete source build. Use Node.js 22 or newer.

| Host setting | Value |
| --- | --- |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| HTTP port | The host's configured `PORT` |
| Replicas | One application instance; sessions are currently in memory |

Set the appropriate database variables from the [README environment table](../../README.md#3-configure-the-environment), the integration master key and the new public HTTPS `APP_BASE_URL`. Set bootstrap passwords only when the initial seeded accounts still need initialization. Existing accounts keep their saved passwords.

If using Google Calendar's `VITE_GOOGLE_CLIENT_ID`, make it available during the build. Keep real environment files and secrets outside Git.

## 3. Build and launch

For a manual deployment:

```bash
npm ci
npm run build
npm run typecheck:server
npm start
```

The Express production server serves both the app and API. `npm run preview` is not the production entry point.

## 4. Verify the deployment

- Open the public app URL and confirm the current version, **v0.7.1**.
- Sign in using existing credentials, or the [fresh-install login accounts](../../README.md#5-sign-in).
- Verify an existing workspace and an evidence download if reusing data.
- Confirm that the server can reach the selected database.
- If the public URL changed, update Gmail/Calendar OAuth callback configuration using the addresses displayed by the app. Update the DocHub webhook as needed.

Moving the app while retaining the same up-to-date database does not require fresh SQL. Apply only missing migrations from the [upgrade guide](upgrade.md).
