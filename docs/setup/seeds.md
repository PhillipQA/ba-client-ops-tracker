# Seeds

Seeds is the company's time and client tracker. This app reads its parents, projects, tasks and project members through
the Seeds Open API ([reference](../seeds-api.md)).

| Seeds | Example | Here |
|---|---|---|
| Parent | Think Library, Inc. | **Client** |
| Project | CURATED MEEPLE OPC (a store or a title) | **Project**, with its contract number |
| Task | Go Live, POS Reset, Meetings | A **Seeds task** pick-list on subtasks of that project |

Seeds is the **source of truth** for clients and projects: they come only from Seeds, linked by Seeds id. Tasks and
subtasks are this app's own, named your way, and each can be linked to one of its project's Seeds tasks.

## Before Seeds

The first time an Administrator turns Seeds on, every client and project that exists then moves to the **Before Seeds**
folder, with all their tasks, subtasks, trackers, documents and emails. Nothing is deleted or merged. Before Seeds:

- is open to **everyone**, whatever their assignments, and stays **editable**;
- shows on Clients and Projects under **Folder › Before Seeds** (records carry a *Before Seeds* badge);
- gets no new clients or projects (those come from Seeds), but new tasks under its projects are fine.

**Trackers bridge the two.** A tracker keeps its Before Seeds client, and its rows keep their tasks. To move a tracker's
work onto Seeds:

1. Tracker details › **Project** › pick one under *From Seeds*. The tracker now also follows that project's client.
2. On a row, open its task cell › **Create a new task** › **Where: Seeds** (the default), the Seeds project and, if
   you like, the Seeds task. Or select rows › **Create tasks** to do many at once.
3. A row on a Before Seeds task switches to the new Seeds task; the old task stays in Before Seeds with its history.
   Subtasks made in the row's other cells go under the new task. Everyone is matched to Seeds by their **email**, and sees the clients
and projects Seeds lists them on as a project member. This app keeps the subtasks, emails, trackers, documents and time.

## Setting it up

1. **Get an application token.** Ask a SEEDS Admin for one with the read permissions below. Seeds gives one
   token per app, not one per person.
   - Required: `core.users.read`, `customers.parents.read`, `projects.projects.read`, `projects.members.read`,
     `projects.tasks.read`.
   - Also ask for `customers.clients.read`: it is used only when a Seeds project names a Seeds client instead of its
     parent.
2. **Put it on the server.** In Northflank, add a secret environment variable `SEEDS_API_TOKEN` with the token, then
   redeploy. Never paste it into the app, chat, Git, logs or screenshots. `SEEDS_API_URL` is optional (default
   `https://seeds.iripple.com/api/v1`).
3. **Turn it on.** An Administrator opens Settings › Integrations › **Seeds** › **Turn on Seeds**. It syncs straight away
   and then every 30 minutes. Anyone can choose **Sync now** on the Seeds page › Sync.
4. **Check the matches.** Settings › Integrations › Seeds lists who Seeds found, who it did not (their email in this app
   differs from Seeds, or they are on no Seeds project), and the field names Seeds sent.

No database migration is needed.

## What a sync does

1. Reads `/users`, `/parents` and `/projects` (100 per page, following `nextCursor`); `/clients` too if a project names
   a Seeds client but not its parent.
2. Reads `/projects/{id}/members` for every open project, and keeps the projects where someone in this app (active, with
   an email) is a member.
3. Reads `/projects/{id}/tasks` for those projects only.
4. For each person: adds their clients (Seeds parents) and projects (with contract numbers), or updates them by Seeds
   id. Nothing is matched by name. When Seeds moves a project to another parent, its tasks and subtasks follow. Each
   project keeps its Seeds tasks for the **Seeds task** dropdown on tasks and subtasks (a subtask without one follows
   its parent). Their Seeds assignments are replaced with their project memberships.

A member's role on the project becomes their job role through the titles in Settings › Roles. With no role on the
membership, their Seeds job title is used, then `Member`. Titles no role claims are listed in Settings › Integrations ›
Seeds; add them to a role there.

People Seeds does not list keep their hand-entered assignments (Settings › Access).

## Who sees what

Settings › **Access**. Visibility is off by default, so turning Seeds on changes nothing about who sees what until an
Administrator turns it on.

Which pages each person gets comes from their **job roles** (Settings › Roles): picked in Users & Permissions, and
from Seeds per project. **Administrators see and change everything**, assigned or not.

| Starting role | Sees | Changes |
|---|---|---|
| Business Analyst | Everything except Settings and Users | Everything it sees |
| Project Manager | Action Center, Seeds, Work Hub, Trackers, Requirements, Reports, AI | Not requirements or reports |
| Product Owner | Action Center, Seeds, Requirements, Documents, Reports, AI | Requirements, documents |
| Developer | Action Center, Tasks, Work Hub, Requirements, AI | Not requirements |
| Quality Assurance | Action Center, Tasks, Requirements, Documents, Trackers, AI | Not requirements |
| Support | Action Center, Tasks, Work Hub, AI | Everything it sees |
| Account Manager | Action Center, Reports, AI | Nothing (read-only) |

Roles add up per project. A project assignment does not open the rest of its client: the client shows by name only.

## Field names

Seeds does not publish its record fields, so they are read leniently (`id`, `name`/`projectName`, `clientId`/`client_id`,
`contractNumber`, `userId`, `email`, `role`/`roleName`, and similar). After the first sync, Settings › Integrations ›
Seeds shows the field names Seeds actually sent; if a value is missing, only
[`server/seeds/seeds-client.ts`](../../server/seeds/seeds-client.ts) needs to change.

## When Seeds is down

The last synced access stays in force and the Seeds page shows when Seeds was last read. Nothing is deleted when a
record disappears from Seeds: work that is not in Seeds keeps working.

## Turning Seeds off

Settings › Integrations › Seeds › **Turn off**. Hand-entered assignments count again; the Seeds links on records stay,
so turning it back on picks up where it left off.

## Later: time logs to Seeds

Writing time entries to Seeds (`POST /time-entries`) needs a separate write permission and each person's Google
sign-in (a Google ID token for an OAuth client ID registered with Seeds Admin). Not built yet.
