# BA Client Ops Tracker

A lightweight, client-centric operations tracker for Business Analysts who need to manage clients, projects, inquiries, follow-ups, activities, reports, and AI-assisted triage without the overhead of a full Jira setup.

## Current feature set

- Login screen with server session cookie
- Initial Administrator login: **Admin / admin**
- No preset/demo clients, projects, tasks, or activities
- Clients and client health
- Projects and delivery status
- Requirements, issues, inquiries, decisions, and follow-ups
- Waiting-on ownership and follow-up dates
- Today / This Week activity planning
- One-way Google Calendar import into editable tracker copies
- Contextual AI BA Assistant with human approval before saving suggestions
- Reports with Activity Gantt, turnaround time, workload, task aging, and CSV export
- Supabase PostgreSQL cloud persistence with local browser cache
- Administrator / Contributor / Viewer roles
- Per-account module access controlled by Administrators
- Editable personal profile: name, email, contact number, and password

## First login

Run the app and open `http://localhost:5173`.

Initial credentials:

```text
Username: Admin
Password: admin
```

After signing in, click **My profile** in the sidebar and change the default password.

> `Admin / admin` is intentionally included for first setup only. Do not keep that default password on a shared or deployed instance.

## Roles and module access

Roles control what a user is allowed to do. Module access controls which parts of the application that user can open.

| Role | Data changes | AI / Calendar | Reports | Manage accounts |
| --- | --- | --- | --- | --- |
| **Administrator** | Full CRUD | Yes | Yes | Yes |
| **Contributor** | CRUD inside assigned modules | If assigned | If assigned | No |
| **Viewer** | Read-only inside assigned modules | No | If assigned | No |

Administrators always have every module. For Contributor and Viewer accounts, an Administrator can enable or disable:

- Action Center
- Clients
- Projects
- Inbox / Inquiries
- Tasks
- Reports
- AI BA Assistant
- Settings

A user's **My profile** remains available even when Settings is not assigned.

### Adding another account

Go to **Settings → Accounts & module access → Add account** and provide:

- name
- username
- email (optional)
- contact number (optional)
- initial password
- role
- allowed modules

Additional users should use the Supabase-backed configuration so their credentials and permissions are available to the server from any browser/device.

## Profile editing

Every signed-in user can open **My profile** from the lower-left sidebar and update:

- display name
- email
- contact number
- password

Users cannot change their own role or module permissions. Those are Administrator-controlled.

## Core workflow

1. Add a **Client**.
2. Add one or more **Projects** for that client.
3. Capture client questions in **Inbox / Inquiries**.
4. Convert understood inquiries into Requirements or Issues.
5. Set **Waiting On** and **Follow-up Date**.
6. Use **Action Center** and Activities for daily work.
7. Use the **AI BA Assistant** to assess messy client input and propose next actions.
8. Resolve/close work and review performance in **Reports**.

The application starts empty except for the required Administrator account. There is no Reset Demo Data feature.

## Tech stack

- React
- TypeScript
- Vite
- Express
- Lucide icons
- Supabase PostgreSQL
- OpenAI Responses API
- Browser `localStorage` as a local cache/fallback

## Run locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

## Supabase cloud database

Supabase is the persistent shared cloud copy. Browser storage remains a local cache/fallback.

### Setup

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql`.
4. Copy your **Project URL** and **service_role** key.
5. Copy `.env.example` to `.env.local` and set:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

6. Restart:

```bash
npm run dev
```

The app will load the cloud tracker state after login. If the Supabase tracker table is empty, the current local state is used to initialize it.

### Migration from the previous demo build

This release uses store schema version 2. When it sees the earlier built-in demo records, it removes the known preset demo clients/projects/items/activities and replaces the old demo account set with the required Administrator account. Unknown user-created records are retained where possible.

## Authentication notes

This version has a real server login boundary for the app API:

- login creates an HTTP-only `SameSite=Strict` session cookie;
- `/api/store` requires authentication;
- `/api/assistant` requires authentication and AI module permission;
- Viewer writes are rejected server-side except edits to that Viewer's own profile;
- Contributor account-management changes are rejected server-side;
- Administrator account and module changes update active sessions on the current server process.

However, this is still an **MVP authentication system**, not a replacement for a full identity provider:

- passwords are SHA-256 hashed rather than using a dedicated slow password-hashing algorithm;
- sessions are stored in server memory and users must sign in again after the Node server restarts;
- account data is currently part of the tracker state document.

For an internet-facing production deployment, migrate authentication to Supabase Auth or another identity provider and enforce authorization with dedicated database policies/tables.

Never commit `.env.local`, `SUPABASE_SERVICE_ROLE_KEY`, or `OPENAI_API_KEY`.

## AI BA Assistant

Choose a client and optionally a project, then paste a client inquiry, meeting note, requirement, or document excerpt. The assistant can propose:

- Issues
- Requirements
- Follow-ups
- Activities
- Client reply drafts

Nothing is added to the tracker until the user explicitly approves it.

### AI setup

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.6-terra
```

Restart `npm run dev` after changing `.env.local`.

## Reports

Reports are calculated from live tracker data and include:

- Activity Gantt
- Average and median turnaround time
- Open workload by client
- Waiting-on breakdown
- Turnaround by client
- Calendar vs tracker activity mix
- Activity completion
- Oldest open work / task aging
- CSV export

Turnaround time uses the actual `resolvedDate`; records without a resolution date are not assigned an invented one.

## Google Calendar import

Calendar integration is one-way and read-only:

```text
Google Calendar → BA Tracker local copy
```

Editing the tracker copy does not update Google Calendar.

Set:

```bash
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

The requested Google scope is `calendar.events.readonly`.


## Patch updates

Version **0.2.0** adds a patch updater so future releases can contain only changed files instead of replacing the full project folder.

### Apply a patch

1. Download the small patch ZIP.
2. Stop the running app with `Ctrl + C`.
3. From the project root, run:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-vX.Y.Z.zip"
```

4. Restart:

```powershell
npm run dev
```

The updater checks the current app version, creates a pre-update backup, applies only the files listed in `patch-manifest.json`, and runs `npm install` only when a patch explicitly says dependencies changed.

Protected paths are never replaced by a patch: `.env.local`, `.git`, `node_modules`, `.patch-backups`, and `.patch-tmp`. Your Supabase database and browser/database records are data, not code files, so applying a code patch does not erase them.

### Check patch status

```powershell
npm run patch:status
```

### Roll back the most recent patch

```powershell
npm run patch:rollback
```

The automatic backups are stored under `.patch-backups/` and are excluded from Git.

> Bootstrap note: if your installed copy is older than v0.2.0, apply the one-time `v0.2.0 patch-updater bootstrap` ZIP by extracting it directly over your existing project folder. After that, use `npm run patch` for future updates.

## Production build

```bash
npm run build
npm start
```

Set these environment variables on your host as needed:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `VITE_GOOGLE_CLIENT_ID`

## Repository structure

```text
ba-client-ops-tracker/
├─ src/
│  ├─ access.ts
│  ├─ auth.ts
│  ├─ AIAssistant.tsx
│  ├─ ai.ts
│  ├─ cloudStore.ts
│  ├─ App.tsx
│  ├─ data.ts
│  ├─ googleCalendar.ts
│  ├─ Reports.tsx
│  ├─ Settings.tsx
│  ├─ main.tsx
│  ├─ styles.css
│  └─ types.ts
├─ scripts/
│  ├─ apply-patch.mjs
│  ├─ patch-status.mjs
│  └─ rollback-patch.mjs
├─ supabase/
│  └─ schema.sql
├─ .env.example
├─ .gitignore
├─ server.ts
├─ index.html
├─ package.json
├─ tsconfig.app.json
├─ tsconfig.json
└─ README.md
```

## Discord Inquiry Capture (v0.3.0)

The tracker can capture Discord direct messages and server messages that @mention the bot as Inbox inquiries.

Server environment variables:

```env
DISCORD_BOT_TOKEN=your-discord-bot-token
DISCORD_ALLOWED_USER_IDS=123456789012345678
APP_BASE_URL=https://your-app.onrender.com
```

`DISCORD_ALLOWED_USER_IDS` is optional but recommended. Separate multiple Discord user IDs with commas. The bot token is server-side only and must never be committed to GitHub.

Behavior:
- A direct message to the bot is captured as an Inquiry.
- A guild/server message is captured only when the bot is @mentioned.
- Discord message IDs are stored as external IDs so the same message is not imported twice.
- If `OPENAI_API_KEY` is configured, the message is cleaned into a concise title/summary and the assistant suggests priority, waiting-on, follow-up date, and client/project mapping when the message clearly names existing records.
- If OpenAI is unavailable, the original message is still captured using safe defaults.
- The bot replies with a confirmation after Supabase saves the inquiry.
- Supabase is required for Discord capture because the bot is a server-side integration and cannot rely on one browser's localStorage.

On Render Free, the web service may spin down during inactivity. A Gateway-based Discord bot can therefore become unavailable while the Render service is asleep. This setup is suitable for testing; use an always-on service for reliable 24/7 capture.

## v0.3.1 — Project + Task workflow

This release changes the operating model from item-centric to task-centric:

- Projects can now be general/internal or optionally linked to a client.
- Clicking a project opens a project dashboard with its tasks and communication log.
- The former **All Items** module is now **Tasks** and the primary action is **Add task**.
- Tasks support a due date in addition to a follow-up date.
- The Tasks module can filter by client, project, due-date window, follow-up window, or overdue dates.
- Client detail no longer shows a Client Items section. It focuses on client context and linked projects.
- **Settings → Task configuration** lets Administrators add task statuses, mark statuses as completed, and choose visible task-table columns.
- Existing data is migrated automatically to schema version 3. Existing work items are preserved as tasks.

## Subtask ordering

Subtasks can be reordered within their parent task by dragging the subtask row. The saved order is persisted with tracker data and is shared through Supabase. Up/down buttons are also available as a keyboard/touch-friendly alternative to drag-and-drop.


## v0.3.6 — live Discord inquiry sync

When Supabase is connected and the signed-in account can access Inbox or Tasks, the open app polls for new Discord-captured inquiries every 12 seconds. Newly discovered records are merged into the browser state without overwriting local edits, the Inbox navigation badge highlights the new count, and Discord inquiries receive a source/new badge. Use **Mark seen** in Inbox to clear the session-level new indicator. Existing Discord records are not re-marked as new after a fresh login/cloud load.
