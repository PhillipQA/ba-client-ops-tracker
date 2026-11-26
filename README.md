# BA Client Ops Tracker

**Version 2.0** · each merged pull request is a build (2.0 · B01, B02…); the current one shows on the sign-in page · [Changelog](CHANGELOG.md)

A workspace for business analysts:

- **Clients, projects, tasks and follow-ups**, with notifications and an Action Center.
- **Seeds** (the company's time and client tracker) as the source of truth for clients and projects; time logged here, with its Seeds task, product and remarks, is sent to Seeds. See [Seeds setup](docs/setup/seeds.md).
- **Work Hub**: Gmail, Discord, GitHub and GitLab in one place.
- **Documents**: BRD, FSD, DRF, sign-offs and test cases, with e-signatures through DocHub.
- **Requirements traceability** (RTM).
- **Trackers**: spreadsheet-like tables that can follow a Google Sheet (one- or two-way) or an Excel file kept in Google Drive (read only), with project timelines and site rollouts that make tasks and subtasks, and comments on cells that sync with the Sheet.
- **GIT Trackers**: GitLab and GitHub tickets added from Work Hub become tracker rows, Tasks and Subtasks, following a GIT template, under the Client and Project each repository is mapped to.
- **Task evidence** kept in the shared Google Drive.
- **Reports** with your own widgets, and an **AI BA assistant** that drafts work for you to approve.

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

It ends with `BA Client Ops Tracker database ready` and the schema version. No `psql`? Open `database/schema.sql` in DBeaver, connected to the empty database, and run the whole script. More in [database/README.md](database/README.md).

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

| Who | Where | Sign in with |
| --- | --- | --- |
| Internal Admin | **http://localhost:5173/internal_admin** | user `admin`, your `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` |
| The first workspace | **http://localhost:5173** | account `BXI-Core`, then user `Admin`, your `BXI_CORE_BOOTSTRAP_PASSWORD` |

Workspace sign-in is two steps: the account first, then user and password (or **Continue with Google**). Internal Admin signs in only at `/internal_admin`; on the normal sign-in page it is just an incorrect account.

The first sign-in saves each bootstrap password as that account's password; changing the variable later does not reset it. Internal Admin must choose a new password straight away; change the BXI-Core one too, from your profile.

- **Internal Admin** manages accounts, which modules each one has, the AI keys (**Internal Admin › AI**) and Seeds sign-in exceptions.
- **BXI-Core** is the first workspace: add people under **Users & Permissions**.

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

**5. Open it.** Use the service's public URL, or add your own domain (see [Use your own domain](#use-your-own-domain)). Sign in as in the quick start, then set up [integrations](#integrations).

### Use your own domain

1. In Northflank **Domains**, add the domain (verify it with the TXT record Northflank shows), then add the subdomain (for example `batracker`). Northflank shows a **CNAME** record: add it at your DNS provider (or ask whoever runs the domain's DNS), wait for **Verify** to pass, and link the subdomain to the service's public port.
2. Set `APP_BASE_URL` to the new `https://` address and redeploy.
3. In Google Cloud, add the new redirect addresses to the Gmail/Calendar client ([Google setup](docs/setup/google.md)) and upload its JSON again in the app; add the new address to the **Authorized JavaScript origins** of the sign-in / Seeds client ([Seeds setup](docs/setup/seeds.md)).
4. Re-create the DocHub webhook from the app's DocHub settings.

Everyone signs in again on the new address; saved Gmail, Drive and Seeds connections stay. Keep the old address linked until nobody uses it.

Only link the **subdomain**. If the main domain (for example `phillipqa.com`) also hosts another site, such as GitHub Pages, leave its records pointing there.

## Update a deployment

Northflank builds and deploys every push to `main`. Before pushing:

1. Read the [changelog](CHANGELOG.md) entry. If it says the database changes, back up the addon and run the new migration from `database/migrations/` against it **first** (as in step 2 above).
2. Check locally: `npm ci && npm run build && npm test`.
3. Push or merge to `main`. Each merged pull request raises the build number (2.0 · B123…). Watch the build in Northflank, then hard-refresh the app (Ctrl+Shift+R) and check the build on the sign-in page.

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
| `TASKS_SOURCE` | no | Where tasks are kept: `tables` (default; the tasks and inquiries tables, needs schema v46) or `snapshot` (inside the workspace snapshot, as before Phase 4C). Set `snapshot` before rolling back to an older build, and save once. |
| `FOLLOW_UP_TIME_ZONE` | no | Time zone for business dates (default `Asia/Manila`). |
| `SMTP_*` | no | Email for **Forgot password**; see [password recovery](docs/setup/password-recovery.md). |
| `SEEDS_API_TOKEN` | for Seeds | The Seeds application token from a SEEDS Admin. Server only: never in the browser, Git, logs or screenshots. See [Seeds setup](docs/setup/seeds.md). |
| `SEEDS_API_URL` | no | The Seeds API address (default `https://seeds.iripple.com/api/v1`). |
| `SEEDS_GOOGLE_CLIENT_ID` | to send time to Seeds | The Google OAuth web client ID registered with the SEEDS Admin. Each person signs in with Google when they send time. Also used for **Sign in with Google** unless `GOOGLE_SIGNIN_CLIENT_ID` is set. |
| `GOOGLE_SIGNIN_CLIENT_ID` | no | A separate Google client for **Sign in with Google**. |

Discord, DocHub and Google (Gmail, Drive, Sheets, Calendar) credentials are entered in the app (**Settings**), and the AI keys in **Internal Admin › AI**, not here.

## Integrations

All optional; the app works without them.

| Integration | Where |
| --- | --- |
| Seeds (clients, projects, members, products; sending time) | `SEEDS_API_TOKEN` and `SEEDS_GOOGLE_CLIENT_ID`, then an Administrator turns Seeds on in Settings → Integrations; see [Seeds setup](docs/setup/seeds.md) and the [Seeds API reference](docs/seeds-api.md). |
| Gmail, Google Drive, Google Sheets, Google Calendar | One Google Cloud project; see [Google setup](docs/setup/google.md). Following Excel files in Drive also needs the `drive.readonly` scope. |
| Shared Google Drive (email attachments, task evidence, signed documents) | Settings → Integrations, connected once by an Administrator. |
| Discord | Settings → Integrations (workspace bot); each user links their Discord ID in Work Hub. |
| GitHub, GitLab | Each user, in Work Hub → integration settings. For GIT Trackers, an Administrator maps each repository to a Client and Project in Settings → Integrations → Repository mapping. |
| DocHub (e-signatures) | Settings → Integrations. |
| AI BA assistant and document agent | **Internal Admin › AI**: one provider, model and key per agent, used by every account. An account gets AI when its **AI** module is on (Internal Admin › the account › Modules). |
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
| Someone can't sign in after Seeds was turned on | Once Seeds is on, every sign-in needs the person's email in Seeds' active-employee directory, Administrators included. Internal Admin › the user › Access › Seeds can let one person sign in with their password without Seeds (Google sign-in always needs Seeds). |
| AI says it isn't set up, or the key is wrong | Internal Admin › AI has the key for that agent, and the account's **AI** module is on. There is no connection test: a wrong key shows as an error the first time someone uses AI. |
| Seeds sync says the token is not accepted or not allowed | `SEEDS_API_TOKEN` is wrong or missing a permission; ask the SEEDS Admin. Settings → Integrations → Seeds shows the last error. |
| A time entry stays "Not sent" | Open the task: the entry shows Seeds' reason. Edit it (pencil) to add what Seeds requires, such as a product, then **Send to Seeds** again. |
| Everyone was signed out | The service restarted or redeployed. Expected; nothing is lost. |

## Project structure

`src/` holds the frontend (one folder per feature under `src/features/`), `server/` the Express API (see [server/README.md](server/README.md)), `database/` the schema, `tests/` the automated tests, `templates/` the document templates and `docs/` the setup guides. See [repository structure](docs/architecture/REPOSITORY-STRUCTURE.md) and the [documentation index](docs/README.md).
