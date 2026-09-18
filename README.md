# BA Client Ops Tracker

A client-centric operations workspace for Business Analysts to manage clients, projects, tasks, inquiries, follow-ups, activities, documents, reports, and AI-assisted triage in one place.

## What the app covers

- **Action Center** — today/this-week activities and task/subtask follow-ups.
- **Clients** — client records, health, notes, and client-specific project/task views.
- **Projects** — general/global projects that can contain tasks for multiple clients.
- **Tasks & Subtasks** — client-required tasks, configurable statuses, due/follow-up dates, owners, priority, collapsible subtasks, drag/drop ordering, and private activity evidence attachments.
- **Inbox / Inquiries** — manual and Discord-captured inquiries, conversion to work, and resolved/converted archive history.
- **Document Creation** — DRF workflow plus FSD and Sign-Off intake areas.
- **AI BA Assistant** — optional OpenAI-powered analysis and drafting with user approval before saving.
- **Reports** — workload, turnaround time, aging, Gantt/activity views, subtask progress, and CSV export.
- **Themes** — per-user visual themes saved with the user profile.
- **Roles & Permissions** — Administrator, Contributor, Viewer, and per-module access.
- **BXI-Core Internal Admin** — platform-level tenant account creation, module entitlements, cross-tenant user administration, and password recovery.
- **Multi-tenancy** — each workspace has isolated state and normalized records scoped by `organization_id`.

## Current operating model

```text
Client
  └─ Task / Subtask
       ├─ Project (global/general)
       ├─ Status
       ├─ Waiting On
       ├─ Priority
       ├─ Owner
       ├─ Due Date
       └─ Follow-up Date
```

Projects are not owned by one client. A project such as `Rollout` can be used by multiple clients, while each task still belongs to a specific client.

## Tech stack

- React + TypeScript + Vite
- Node.js + Express
- Supabase PostgreSQL
- Discord.js
- Tesseract.js + PDF.js for local COR extraction
- OpenAI API for optional AI features

## Quick start

### 1. Install and run

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

### 2. Login model

The login screen uses three fields:

```text
Account
User
Password
```

The original workspace is the **BXI-Core** tenant. Existing users sign in with `Account: BXI-Core` plus their normal username/password.

The platform control plane has a separate identity:

```text
Account: internal_admin
User: admin
```

There is **no hardcoded default password** in v0.6.2. For first secure bootstrap, set `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` in Render to a unique value of at least 12 characters, then sign in once and change it from **Internal Admin → Security**. The `internal_admin` identity does not belong to a tenant workspace.

## Environment configuration

Create `.env.local` from `.env.example` and configure only the integrations you use.

### Required for shared cloud persistence

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Optional — AI BA Assistant / AI-enhanced Discord processing

```env
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.6-terra
```

`OPENAI_API_KEY` is **not required for COR extraction**. DRF COR reading runs locally in the browser.

### Secure bootstrap credentials

For a fresh install or when `schema-v5-security-hardening.sql` replaces an unchanged legacy `admin/admin` credential, configure strong one-time bootstrap passwords in Render:

```env
INTERNAL_ADMIN_BOOTSTRAP_PASSWORD=use-a-unique-12+-character-secret
BXI_CORE_BOOTSTRAP_PASSWORD=use-a-different-12+-character-secret
```

After both accounts have successfully bootstrapped and their passwords are changed, these variables are no longer used for normal authentication and can be rotated/removed.

### Optional — Discord inquiry capture

```env
DISCORD_BOT_TOKEN=your-discord-bot-token
DISCORD_ALLOWED_USER_IDS=123456789012345678
DISCORD_ORGANIZATION_SLUG=bxi-core
APP_BASE_URL=https://your-app.onrender.com
```

For production, configure `DISCORD_ALLOWED_USER_IDS`; the server logs a security warning when Discord capture is enabled without an allowlist.

`DISCORD_ALLOWED_USER_IDS` is optional. Separate multiple IDs with commas. `DISCORD_ORGANIZATION_SLUG` selects which tenant receives this bot's inquiries; it defaults to `bxi-core`. A future tenant-specific Discord configuration can support multiple bot/workspace mappings.

### Optional — Google Calendar import

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Calendar import is one-way/read-only:

```text
Google Calendar → BA Tracker local copy
```

Edits inside the tracker do not update the original Google Calendar event.

## Supabase setup

Run these scripts once in **Supabase → SQL Editor**, in order:

1. `supabase/schema.sql`
2. `supabase/schema-v2.sql`
3. `supabase/schema-v3-multitenant.sql`
4. `supabase/schema-v4-account-login.sql`
5. `supabase/schema-v5-security-hardening.sql`
6. `supabase/schema-v6-tenant-save-integrity.sql`

`schema-v3-multitenant.sql` creates the first tenant as **BXI-Core**, copies the existing `tracker_state` into `tenant_state`, and assigns existing normalized records to BXI-Core. The original `tracker_state` remains a compatibility copy during the migration window.

`schema-v4-account-login.sql` separates the platform control-plane identity into `platform_users` and changes tenant username uniqueness from global to **per account/workspace**. Fresh bootstrap accounts use a non-login marker rather than a known password.

`schema-v5-security-hardening.sql` safely replaces only the unchanged legacy `admin/admin` hashes with bootstrap markers. Existing users with other legacy SHA-256 hashes are left intact and automatically upgraded to bcrypt after their next successful login.

`schema-v6-tenant-save-integrity.sql` adds a server-only transactional save function. It rejects record IDs owned by another tenant and commits structured records, audit entries, tenant state and the BXI-Core compatibility snapshot together. It does not rewrite existing records or credentials. Install this migration before starting v0.6.3; writes return a clear migration-required error if it is missing.

Structured records include:

- `clients`
- `projects`
- `tasks`
- `inquiries`
- `activity_logs`
- `planner_activities`
- `app_users`
- `task_statuses`
- `app_settings`
- `audit_logs`

After the schemas are installed, **Settings → Data Architecture → Migrate / Sync now** can re-synchronize the current workspace's structured tables.

### Data protection model

- Structured records use soft deletion where supported (`deleted_at`).
- Audit records retain before/after snapshots for tracked changes.
- `.env.local`, service-role keys, bot tokens, and API keys must never be committed to Git.
- Subtask evidence files are stored privately in Supabase Storage (`task-evidence` bucket); only attachment metadata is stored with the subtask record.
- Supabase Storage for uploaded/generated document-creation files is still planned separately; those document binaries are not stored directly in PostgreSQL.


## Multi-tenant model

Each customer/workspace is represented by an `organizations` row. Operational data and the normalized tables carry an `organization_id`, while each workspace has its own JSON compatibility state in `tenant_state`.

```text
BXI-Core platform
  ├─ BXI-Core workspace (existing data)
  ├─ Tenant A
  │    ├─ users
  │    ├─ clients
  │    ├─ projects
  │    └─ tasks / inquiries / documents
  └─ Tenant B
       └─ isolated data
```

The Node server resolves the signed-in user's organization and only loads/saves that tenant's state. Normalized syncs, audit logs, Discord inquiry reads, and subtask evidence paths are also tenant-scoped. Direct browser table access remains revoked; RLS is enabled and the v3 schema includes a tenant-claim policy foundation for a later Supabase Auth phase.

### BXI-Core Internal Admin

Platform administration is intentionally separate from tenant access. Sign in with:

```text
Account: internal_admin
User: admin
Password: value configured in INTERNAL_ADMIN_BOOTSTRAP_PASSWORD on first bootstrap
```

After bootstrap, the stored password is bcrypt-protected and the environment bootstrap value is no longer consulted. That session opens the **BXI-Core Internal Admin** control plane only; it does not load BXI-Core tenant data.

Internal Admin can:

- create a new tenant account/workspace and its first Administrator;
- define the tenant's login Account ID;
- enable/disable modules at the tenant level;
- see total and active tenant/user counts;
- add users inside any tenant;
- enable/disable tenant users;
- set a temporary/recovery password for users in any tenant;
- suspend/reactivate tenant accounts;
- change the Internal Admin password.

Tenant Administrators still manage users inside their own workspace through **Settings → Accounts & module access**, but they cannot grant modules disabled at the tenant level. Usernames only need to be unique **inside the same tenant**, so different tenants can each have a user named `admin`.

## Accounts and permissions

### Roles

| Role | Access |
| --- | --- |
| **Administrator** | Full data access, settings, accounts, roles, and module permissions |
| **Contributor** | Create/update operational data inside assigned modules |
| **Viewer** | Read-only access inside assigned modules |

Administrators can control module access per account. Every user can still access **My profile** to update personal details and theme preferences.

Authentication is currently app-managed with server sessions; Supabase Auth is not yet the login provider. Tenant login is resolved by `Account + User + Password`. Passwords are stored using bcrypt (12 rounds) over the existing SHA-256 pre-digest for backward compatibility; legacy SHA-256 records are upgraded automatically after successful login. Platform password recovery sets a new temporary tenant-user password and invalidates that user's active in-memory sessions.

## Tasks and subtasks

- A **Client is required** when creating a normal task.
- Creating a task from a client page keeps that client selected and locked.
- Projects remain global and are selected after the client context is known.
- Subtasks inherit the parent task's client/project context.
- Subtasks can be reordered by drag-and-drop or Move Up/Move Down controls.
- Parent task rows can collapse/expand their subtasks.
- Follow-up dates on both tasks and subtasks appear in **Action Center → Activities**.
- Hovering a task/subtask title in **Action Center → Activities** shows its saved description/comments in a quick preview tooltip.
- Subtasks can store activity evidence: choose files, drag/drop attachments, or paste screenshots with `Ctrl+V`. Evidence is saved privately in Supabase Storage and upload/remove actions are recorded in activity/audit history.
- Week views run **Sunday through Saturday**.

## Inbox / Discord inquiries

Discord can create Inbox inquiries from:

- direct messages to the bot;
- server messages that @mention the bot.

The tracker polls Supabase for new external inquiries while the app is open. Resolved or converted Discord inquiries remain available in the Inbox archive for history/backtracking.

> A Gateway-based Discord bot needs the Node service to stay online. Free hosting that sleeps may make the bot temporarily unavailable.

## Document Creation

### DRF Creation

Current DRF workflow:

```text
Upload COR
  ↓
Local text extraction / OCR
  ↓
Review extracted company data
  ↓
Complete DRF-specific fields
  ↓
Add POS/device rows
  ↓
Configure signatories
  ↓
Apply values to Excel template
  ↓
Download generated .xlsx DRF
```

COR extraction supports common image formats, PDF, and DOCX. The core extracted fields are:

- Business / Registered Name (`Name of Taxpayer`)
- Trade / Business Name
- TIN
- Registered Address

The approved Excel DRF template also supports:

- Branch Name
- Request Date (auto-generated in `MM/DD/YYYY`)
- GO-LIVE Date
- Contract Number / SLSS-DRF
- Notes / Instructions
- Request For
- Dongle
- License For
- Request Note
- POS Setup
- repeatable POS/device rows: Computer Name, POS Machine Serial No., Machine Brand, Machine Model
- three configurable signatories: Prepared By, Authorized By, Approved By

### FSD Creation

Requires a BRD source document before proceeding. Final FSD output generation will be completed against the approved FSD template.

### Sign-Off Form

Supports supporting-document intake. Final generation will be completed against the approved Sign-Off template.

## Themes

Users can change their own theme from **Settings → Personalization** or **My profile**.

Available themes:

- Default
- Dark Geek Mode
- Light Blue Sky Beach Mode
- Green Grass with Insects
- Busy City Streets
- Calm Mountain — Bahay Kubo

Theme selection is stored per user and follows the account after Supabase synchronization.

## Reports

Reports are generated from tracker data and include:

- Activity Gantt
- Average/median turnaround time
- Open workload by client
- Waiting-on breakdown
- Turnaround by client
- Calendar vs tracker activity mix
- Activity completion
- Task aging / oldest open work
- Subtask progress
- CSV export

## Patch updates

### Direct v0.5.4 to v0.6.3 upgrade

Use `ba-client-ops-patch-v0.6.3-from-v0.5.4.zip` when the installed version is v0.5.4. This cumulative patch installs the multi-tenant and account-login changes as well as both security fixes. After applying it, configure the secure bootstrap passwords described above and run schema-v3-multitenant.sql, schema-v4-account-login.sql, schema-v5-security-hardening.sql and schema-v6-tenant-save-integrity.sql in that order before restarting. Existing changed passwords are retained; an unchanged default Admin password is replaced by the secure bootstrap flow. See `INSTALL_FROM_0.5.4.md` inside the ZIP for the exact Windows command and migration steps.

### v0.6.3 upgrade from v0.6.2

Stop the running app, apply `ba-client-ops-patch-v0.6.3-tenant-save-fixes.zip`, then run the new `supabase/schema-v6-tenant-save-integrity.sql` in Supabase SQL Editor. Schemas v1 through v5 must already be installed. `npm run patch` copies the SQL file but does not execute it. Build and restart the app after the migration, then refresh open browser tabs.

This release fixes cross-tenant record overwrites, missing account snapshots on fresh BXI-Core installs, saves in workspaces with restricted modules, and Contributor saves affected by missing theme defaults. Fresh or incomplete snapshots recover missing users from the existing authentication table; operational data and passwords are retained. No new dependencies or environment variables are required.

Tenant saves now fail and roll back when a structured record is invalid; they no longer report success after a normalized-sync failure. If old cached data contains an invalid date or duplicate record ID, correct that field and retry the save.

### Apply a patch

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-vX.Y.Z.zip"
```

The updater checks the installed version, creates a rollback backup, applies only listed files, and runs `npm install` only when dependencies change.

Protected local paths include `.env.local`, `.git`, `node_modules`, `.patch-backups`, and `.patch-tmp`.

### Check status

```powershell
npm run patch:status
```

### Roll back the latest patch

```powershell
npm run patch:rollback
```

## Production build

```bash
npm run build
npm start
```

For Render or another host, configure the same environment variables in the host's environment settings instead of committing them to the repository.

## Repository structure

```text
ba-client-ops-tracker/
├─ public/                  # branding and theme assets
├─ scripts/                 # patch/app rollback utilities
├─ src/                     # React UI and client-side logic
├─ supabase/
│  ├─ schema.sql            # compatibility tracker_state schema
│  ├─ schema-v2.sql         # normalized/auditable data tables
│  ├─ schema-v3-multitenant.sql # organizations, tenant state, tenant scoping
│  ├─ schema-v4-account-login.sql # account-aware login / platform identity
│  ├─ schema-v5-security-hardening.sql # secure bootstrap migration
│  └─ schema-v6-tenant-save-integrity.sql # atomic tenant-scoped saves
├─ server.ts                # Express API, auth, Supabase, Discord, document endpoints
├─ package.json
└─ README.md
```

## Security notes

- Never commit `.env.local` or secret keys/tokens.
- Rotate credentials immediately if they are exposed.
- `/api/store` never returns real password hashes to the browser, including Administrator sessions.
- Password storage uses salted bcrypt with legacy SHA-256 login compatibility and automatic upgrade.
- Login failures are rate-limited to reduce brute-force attempts.
- Production session cookies add `Secure`, and all session cookies remain `HttpOnly` + `SameSite=Strict`.
- Configure `DISCORD_ALLOWED_USER_IDS` when Discord capture is enabled in production.
- The current login/session system remains app-managed. Multi-tenant data isolation is enforced by the Node server and tenant-scoped storage paths, while direct browser table grants remain revoked. A future Supabase Auth migration is still recommended for stronger identity lifecycle, email-based recovery, and user-scoped JWT/RLS enforcement.
