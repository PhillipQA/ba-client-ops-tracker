# BA Client Ops Tracker

**Current application version: v0.6.84**

A workspace for clients, projects, tasks, follow-ups, Work Hub communications, document creation, requirements traceability and reports. This guide covers installation, first login, deployment and updates.

Already installed? Go to [Update an existing installation](#update-an-existing-installation). Read the [changelog](CHANGELOG.md) for changes by version.

## Requirements

- Node.js **22 or newer**, with npm. Check with `node --version` and `npm --version`.
- Git and access to this private repository, or a complete source ZIP.
- A configured database: Supabase for the fresh setup below, or an already imported/prepared PostgreSQL database.
- An environment file for local development, or environment variables configured on the application host.

The application uses React, TypeScript and Vite with an Express server. Run the commands below from the folder containing `package.json`.

## Install locally

### 1. Get the source and install dependencies

```bash
git clone https://github.com/PhillipQA/ba-client-ops-tracker.git
cd ba-client-ops-tracker
npm ci
```

If using a source ZIP, extract the complete project, open a terminal in that folder and run `npm ci`. Keep `package-lock.json`; it pins the dependency versions used by the build.

### 2. Choose the database setup

| Situation | Action |
| --- | --- |
| New installation with a new, empty Supabase project | Run the complete [database/setup.sql](database/setup.sql) once in Supabase SQL Editor. The result should report schema version **21**. |
| Existing Supabase database | Reuse its URL and service-role key. Apply only missing migrations from the [upgrade guide](docs/setup/upgrade.md). |
| Existing Northflank PostgreSQL database with imported tracker data | Use `DATABASE_PROVIDER=postgres` and `DATABASE_URL`. The database must already have the tracker schema, permissions and evidence storage. |
| Moving existing Supabase data to Northflank PostgreSQL | Follow the [PostgreSQL cutover guide](docs/setup/northflank-postgres-cutover.md) before changing the running service. |

**Do not run the fresh setup script on an existing or restored database.** It creates an empty installation; it does not transfer your current data. The script targets Supabase and is not a standalone fresh-install script for a plain PostgreSQL addon.

### 3. Configure the environment

Copy the example file.

**Windows PowerShell**

```powershell
Copy-Item .env.example .env.local
```

**macOS / Linux**

```bash
cp .env.example .env.local
```

Edit `.env.local` and replace the placeholders.

| Variable | When required |
| --- | --- |
| `DATABASE_PROVIDER` | `supabase` for Supabase; `postgres` for a prepared PostgreSQL database. The default is Supabase. |
| `SUPABASE_URL` | Supabase mode: your project's URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase mode: your project's server-side service-role key. |
| `DATABASE_URL` | PostgreSQL mode: the application user's connection URI, including the database host's required TLS settings. |
| `TENANT_INTEGRATION_MASTER_KEY` | Key for encrypted integration credentials. Generate it for a new installation; preserve the existing key when upgrading or moving data. |
| `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` | Fresh installation: choose at least 12 characters for the initial Internal Admin login. |
| `BXI_CORE_BOOTSTRAP_PASSWORD` | Fresh installation: choose at least 12 characters for the initial BXI-Core administrator login. |
| `APP_BASE_URL` | `http://localhost:5173` locally; the public HTTPS origin when hosted. Do not include a query string or fragment. |
| `PORT` | Defaults to `5173` locally. Use the port supplied/configured by your host in production. |

Generate a new integration key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the result into `TENANT_INTEGRATION_MASTER_KEY`. Real environment files and credentials are excluded from Git. Existing users keep their saved passwords; bootstrap passwords do not reset an existing account.

### 4. Start the app

```bash
npm run dev
```

Open **http://localhost:5173**. If you changed `PORT`, use that port instead. The Express server also serves the Vite development frontend; no second server is needed.

### 5. Sign in

For a fresh installation:

| Account | User | Password |
| --- | --- | --- |
| `internal_admin` | `admin` | Your `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` |
| `BXI-Core` | `Admin` | Your `BXI_CORE_BOOTSTRAP_PASSWORD` |

Internal Admin manages accounts, enabled modules and platform integration access. BXI-Core opens the initial tenant workspace. Complete the Internal Admin password-change prompt, then configure users and integrations as needed.

For an existing/imported database, use its existing account and user credentials.

## Build and deploy

Build and validate the source:

```bash
npm ci
npm run build
npm run typecheck:server
npm start
```

`npm start` runs the Express server in production mode and serves `dist/`. **Do not use `npm run preview` as the deployed app server**; it does not provide the Express API.

For Northflank or another Node host:

| Setting | Value |
| --- | --- |
| Source | This repository and the intended branch, normally `main` |
| Node version | 22 or newer |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Environment | The database variables above, the existing integration key and the public `APP_BASE_URL` |
| HTTP port | The value configured/provided as `PORT` |

Configure environment values before building if using the optional `VITE_GOOGLE_CLIENT_ID`. Run **one application instance**: login sessions are stored in server memory. A restart can require signing in again; database records remain in the database. Sessions end 8 hours after sign-in, or after 2 hours without activity (change this with `SESSION_IDLE_TIMEOUT_MINUTES`).

Follow [Deploy on a new server](docs/setup/deploy-new-server.md) for moving an existing installation.

## Optional integrations

The app can be installed before connecting external services.

| Feature | Setup location |
| --- | --- |
| Gmail | Internal Admin enables access; the account administrator configures OAuth; each user connects Gmail and selects labels in Work Hub. |
| Discord | Account Settings configures the workspace bot; users link their Discord IDs in Work Hub. |
| GitHub / GitLab | Each user's Work Hub integration settings. |
| DocHub | Account Settings integration configuration. |
| BA Assistant / Document Agent | Account Settings → AI Agent Manager. |
| Google Calendar | Configure the public Google client ID and the account settings shown by the app. |
| Email password recovery | Server SMTP variables and registered user emails; see [password recovery setup](docs/setup/password-recovery.md). |

Work Hub syncs connected integrations once at sign-in. **Refresh now** syncs all; each integration's **Sync** button refreshes only that source. Creating tasks from an email does not trigger another Gmail sync.

## Update an existing installation

1. Back up the database and any separately stored files. Keep the environment values and integration master key.
2. Review the [changelog](CHANGELOG.md) and [upgrade guide](docs/setup/upgrade.md). Apply only the migrations your database is missing.
3. From your existing checkout, update and validate:

```bash
git pull --ff-only
npm ci
npm run build
npm run typecheck:server
```

4. Restart with `npm start`, or redeploy through your host. Confirm the version shown on the login page.

If your checkout contains local source edits, reconcile them before pulling. For an official patch ZIP, use the [patch instructions](docs/setup/upgrade.md#official-patch-zips); a source update does not require a patch ZIP.

**v0.6.84 adds no database migration.** The optional schema v22 migration (from v0.6.83) enables custom templates for the UAT Sign Off, UAT Deployment Approval and Training Sign Off forms; the built-in forms and templates work without it. The optional v21 migration enables custom Go Live templates.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Invalid credentials on a fresh installation | Run the database setup, set both bootstrap passwords and use the Account/User values above. Restart after changing the environment. |
| Database unavailable or schema missing | Check the selected provider, database connection, schema and application-user permissions. Follow the database/upgrade guide for the installed version. |
| Cannot reach a private Northflank database from your computer | The app needs a reachable database URI. For desktop administration, use the addon connection/forwarding configuration rather than assuming its private hostname is public. |
| Blank page or an older version after deployment | Confirm the host built and started successfully. Hard-refresh with Ctrl+Shift+R; if the old HTML is still cached, check in a private browser window. |
| Production page loads but API requests fail | Run `npm start`, not `npm run preview`, and check the server logs/environment. |
| Forgot password email does not arrive | Configure SMTP, save the user's recovery email and check [password recovery setup](docs/setup/password-recovery.md). |

## Documentation and checks

- [Changelog](CHANGELOG.md) — current and recent updates.
- [Documentation index](docs/README.md) — setup and reference guides.
- [Release archive](docs/releases/README.md) — detailed notes by version.
- [Database guide](database/README.md) — fresh setup versus existing database upgrades.

Focused Work Hub checks:

```bash
npm run test:communications
npm run test:work-hub-tasks
npm run test:work-hub-sync
```

`npm run test:functional` runs the wider functional regression selection.
