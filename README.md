# BA Client Ops Tracker

**Version 1.6.0** · [Changelog](CHANGELOG.md)

A workspace for business analysts: clients, projects, tasks and follow-ups, Work Hub (Gmail, Discord, GitHub, GitLab), document creation (BRD, FSD, DRF, sign-offs), requirements traceability, trackers that can follow a Google Sheet, reports, and an AI BA assistant.

It is a React + Vite frontend served by an Express server (TypeScript, Node.js), with a PostgreSQL database. In production it runs on [Northflank](https://northflank.com).

- [Quick start (your computer)](#quick-start-your-computer)
- [Deploy on Northflank](#deploy-on-northflank)
- [Update a deployment](#update-a-deployment)
- [Settings (environment variables)](#settings-environment-variables)
- [Integrations](#integrations)
- [Commands](#commands)
- [Troubleshooting](#troubleshooting)

## What you need

- **Node.js 22 or newer**, with npm (`node --version`).
- **PostgreSQL 14 or newer**: a local one, or the Northflank addon forwarded to your computer.
- **Git**, with access to this repository.

## Quick start (your computer)

**1. Get the code**

```bash
git clone https://github.com/PhillipQA/ba-client-ops-tracker.git
cd ba-client-ops-tracker
npm ci
```

**2. Create the database**

Create an empty database, then run the schema once, as the user the app will connect with:

```bash
createdb ba_tracker
psql "postgresql://localhost/ba_tracker" -v ON_ERROR_STOP=1 -f database/schema.sql
```

It ends with `BA Client Ops Tracker database ready | 36`. No `psql`? Open `database/schema.sql` in DBeaver, connected to the empty database, and run the whole script. More in [database/README.md](database/README.md).

**3. Add your settings**

```bash
cp .env.example .env.local        # Windows PowerShell: Copy-Item .env.example .env.local
```

Edit `.env.local`:

- `DATABASE_URL`: the database from step 2, e.g. `postgresql://localhost/ba_tracker`.
- `TENANT_INTEGRATION_MASTER_KEY`: generate one with
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` and `BXI_CORE_BOOTSTRAP_PASSWORD`: any two passwords of 12+ characters.

**4. Start it**

```bash
npm run dev
```

Open **http://localhost:5173**. One server runs both the app and its API.

**5. Sign in**

| Account | Username | Password |
| --- | --- | --- |
| `internal_admin` | `admin` | your `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` |
| `BXI-Core` | `Admin` | your `BXI_CORE_BOOTSTRAP_PASSWORD` |

The first sign-in saves each bootstrap password as that account's password; changing the variable later does not reset it. Internal Admin must choose a new password straight away; change the BXI-Core one too, from your profile. **Internal Admin** manages accounts and which modules they have. **BXI-Core** is the first workspace: add people under **Users & Permissions**.

## Deploy on Northflank

Do this once per environment. Everything below is in the Northflank project dashboard.

**1. Database.** Create a **PostgreSQL** addon (version 16, private, with backups on).

**2. Schema.** Forward the addon to your computer and run the schema with the addon's `POSTGRES_URI` (from the addon's **Connection details**):

```bash
sudo northflank forward addon --projectId <project> --addonId <addon>
psql "<POSTGRES_URI>" -v ON_ERROR_STOP=1 -f database/schema.sql
```

Without `sudo`, add `--skipHostnames` and connect to the address and port the CLI prints. DBeaver through the forwarded port works too. If the script says `permission denied for schema public`, run it with the `POSTGRES_URI_ADMIN` connection string instead, then give the app's user access (its username is in `POSTGRES_URI`):

```sql
grant usage on schema public to "<app user>";
grant select, insert, update, delete on all tables in schema public to "<app user>";
alter default privileges in schema public grant select, insert, update, delete on tables to "<app user>";
```

**3. Settings.** Create a **secret group** of runtime variables:

- link the addon's `POSTGRES_URI` with the alias **`DATABASE_URL`**;
- add `TENANT_INTEGRATION_MASTER_KEY` (generate it as above; keep it forever, see [Settings](#settings-environment-variables));
- add `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` and `BXI_CORE_BOOTSTRAP_PASSWORD`;
- add `APP_BASE_URL` (the public `https://` address, no trailing slash) and `PORT=8080`.

**4. Service.** Create a **combined service**:

| Setting | Value |
| --- | --- |
| Repository / branch | `PhillipQA/ba-client-ops-tracker`, `main` |
| Build | Buildpack (Node.js). It runs `npm ci` and `npm run build` |
| Start command | `npm start` (never `npm run preview`: it has no API) |
| Port | `8080`, HTTP, **public** |
| Instances | **1** (sign-ins are kept in the server's memory) |
| Secret group | the group from step 3 |

**5. Open it.** Use the service's public URL, or add your own domain under **Networking**; then set `APP_BASE_URL` to that address. Sign in as in the quick start, then set up [integrations](#integrations).

## Update a deployment

Northflank builds and deploys every push to `main`. Before pushing:

1. Read the [changelog](CHANGELOG.md) entry. If it says the database changes, back up the addon and run the new migration from `database/migrations/` against it **first** (as in step 2 above).
2. Check locally: `npm ci && npm run build && npm test`.
3. Push or merge to `main`. Watch the build in Northflank, then hard-refresh the app (Ctrl+Shift+R) and check the version on the sign-in page.

A restart or deploy signs everyone out; their data is unaffected. To roll back, redeploy the previous build in Northflank.

## Settings (environment variables)

Locally they go in `.env.local` (see [.env.example](.env.example)); on Northflank, in the secret group.

| Variable | Needed | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. On Northflank: the addon's `POSTGRES_URI`. |
| `TENANT_INTEGRATION_MASTER_KEY` | yes | 64 hex characters. Encrypts saved integration credentials and tracker Secret cells. **Never change it** on a database that has data: what it encrypted can no longer be read. |
| `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD`, `BXI_CORE_BOOTSTRAP_PASSWORD` | first sign-in | 12+ characters each. Read only at the first sign-in of the two starting accounts. |
| `APP_BASE_URL` | yes | The app's address: `http://localhost:5173` locally, the public `https://` address when hosted. Used in sign-in links and Google redirect addresses. |
| `PORT` | no | Port the server listens on (default `5173`). |
| `SESSION_IDLE_TIMEOUT_MINUTES` | no | Sign-out after this many idle minutes (default 120). Sessions also end 8 hours after sign-in. |
| `FOLLOW_UP_TIME_ZONE` | no | Time zone for business dates (default `Asia/Manila`). |
| `SMTP_*` | no | Email for **Forgot password**; see [password recovery](docs/setup/password-recovery.md). |

Discord, DocHub, AI providers and Google credentials are entered in the app (**Settings**), not here.

## Integrations

All optional; the app works without them.

| Integration | Where |
| --- | --- |
| Gmail, Google Drive, Google Sheets, Google Calendar | One Google Cloud project; see [Google setup](docs/setup/google.md). |
| Discord | Settings → Integrations (workspace bot); each user links their Discord ID in Work Hub. |
| GitHub, GitLab | Each user, in Work Hub → integration settings. |
| DocHub (e-signatures) | Settings → Integrations. |
| AI BA assistant and document agent | Settings → AI Agent Manager. |
| Forgot password emails | `SMTP_*` settings; see [password recovery](docs/setup/password-recovery.md). |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app locally with live reload, on `PORT` (default 5173). |
| `npm run build` | Type-checks the frontend and builds it into `dist/`. |
| `npm start` | Runs the production server (serves `dist/` and the API). |
| `npm test` | Runs every automated test. `npm run test:trackers`, `test:communications` and others run one area. |
| `npm run typecheck:server` | Type-checks the server code. |
| `npm run format` / `npm run lint` / `npm run check` | Formats the code / lists lint findings / what CI runs ([Biome](https://biomejs.dev)). |

GitHub Actions runs the build, Biome and the tests on every push and pull request.

## Troubleshooting

| Problem | Check |
| --- | --- |
| "Invalid credentials" on a new install | Both bootstrap passwords set (12+ characters), the server restarted after setting them, and the Account/Username exactly as in the table above. |
| "Database is not configured" | `DATABASE_URL` is set for the server process (and, on Northflank, the secret group is attached to the service). |
| "…is unavailable. Check the database connection; a new database needs database/schema.sql." | The database is unreachable, or `schema.sql` was never run on it. |
| `permission denied` errors in the server log | The app's database user lacks access: run the `grant` statements in [Deploy on Northflank](#deploy-on-northflank) step 2. |
| Saved integrations stopped working after a move | `TENANT_INTEGRATION_MASTER_KEY` changed. Restore the old key. |
| Blank page or the old version after a deploy | The build failed (check Northflank's build log), or the browser cached the old page: hard-refresh (Ctrl+Shift+R). |
| Pages load but nothing saves | The service runs `npm run preview` instead of `npm start`. |
| Google says "redirect_uri_mismatch" | The redirect addresses in Google Cloud must match `APP_BASE_URL`; see [Google setup](docs/setup/google.md). |
| Everyone was signed out | The service restarted or redeployed. Expected; nothing is lost. |

## Project structure

`src/` holds the frontend (one folder per feature under `src/features/`), `server/` the Express API (see [server/README.md](server/README.md)), `database/` the schema, `tests/` the automated tests, `templates/` the document templates and `docs/` the setup guides. See [repository structure](docs/architecture/REPOSITORY-STRUCTURE.md) and the [documentation index](docs/README.md).
