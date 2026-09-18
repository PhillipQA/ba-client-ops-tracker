# BA Client Ops Tracker

A client-centric operations workspace for Business Analysts to manage clients, projects, tasks, inquiries, follow-ups, activities, documents, reports, and AI-assisted triage in one place.

## What the app covers

- **Action Center** — today/this-week activities and task/subtask follow-ups.
- **Clients** — client records, health, notes, and client-specific project/task views.
- **Projects** — general/global projects that can contain tasks for multiple clients.
- **Tasks & Subtasks** — client-required tasks, configurable statuses, due/follow-up dates, owners, priority, collapsible subtasks, and drag/drop ordering.
- **Inbox / Inquiries** — manual and Discord-captured inquiries, conversion to work, and resolved/converted archive history.
- **Document Creation** — DRF workflow plus FSD and Sign-Off intake areas.
- **AI BA Assistant** — optional OpenAI-powered analysis and drafting with user approval before saving.
- **Reports** — workload, turnaround time, aging, Gantt/activity views, subtask progress, and CSV export.
- **Themes** — per-user visual themes saved with the user profile.
- **Roles & Permissions** — Administrator, Contributor, Viewer, and per-module access.

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

### 2. Initial login

```text
Username: Admin
Password: admin
```

Change the default password immediately from **My profile**.

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

### Optional — Discord inquiry capture

```env
DISCORD_BOT_TOKEN=your-discord-bot-token
DISCORD_ALLOWED_USER_IDS=123456789012345678
APP_BASE_URL=https://your-app.onrender.com
```

`DISCORD_ALLOWED_USER_IDS` is optional. Separate multiple IDs with commas.

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

The app currently keeps `tracker_state` as a compatibility/fallback copy while also writing structured records to normalized tables such as:

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

After the v2 schema is installed, open **Settings → Data Architecture v2 → Migrate / Sync now** once as an Administrator to populate the normalized tables from existing data.

### Data protection model

- Structured records use soft deletion where supported (`deleted_at`).
- Audit records retain before/after snapshots for tracked changes.
- `.env.local`, service-role keys, bot tokens, and API keys must never be committed to Git.
- Supabase Storage for uploaded/generated documents is planned separately; document binaries are not stored directly in PostgreSQL.

## Accounts and permissions

### Roles

| Role | Access |
| --- | --- |
| **Administrator** | Full data access, settings, accounts, roles, and module permissions |
| **Contributor** | Create/update operational data inside assigned modules |
| **Viewer** | Read-only access inside assigned modules |

Administrators can control module access per account. Every user can still access **My profile** to update personal details and theme preferences.

Authentication is currently app-managed with server sessions; Supabase Auth is not yet the login provider.

## Tasks and subtasks

- A **Client is required** when creating a normal task.
- Creating a task from a client page keeps that client selected and locked.
- Projects remain global and are selected after the client context is known.
- Subtasks inherit the parent task's client/project context.
- Subtasks can be reordered by drag-and-drop or Move Up/Move Down controls.
- Parent task rows can collapse/expand their subtasks.
- Follow-up dates on both tasks and subtasks appear in **Action Center → Activities**.
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
│  └─ schema-v2.sql         # normalized/auditable data tables
├─ server.ts                # Express API, auth, Supabase, Discord, document endpoints
├─ package.json
└─ README.md
```

## Security notes

- Never commit `.env.local` or secret keys/tokens.
- Rotate credentials immediately if they are exposed.
- The current login/session system is suitable for the app's present MVP stage, but a future Supabase Auth migration is recommended for stronger production identity management, password recovery, and policy-based authorization.
