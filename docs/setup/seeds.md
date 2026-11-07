# Seeds

Seeds is the company's time and client tracker. Each person connects their **own** Seeds with their personal API key,
and sees the clients and projects Seeds tags to them. This app keeps the subtasks, emails, trackers, documents and time.

## Before anyone connects

1. Run [`database/migrations/schema-v36-seeds.sql`](../../database/migrations/schema-v36-seeds.sql) once on the live
   database (a new database already has it). It adds the table that holds each person's encrypted Seeds key.
2. An Administrator opens Settings › Integrations › **Seeds**, enters the Seeds API address (https only) and chooses
   **Turn on Seeds**. No key is needed here.

## Each person connects

Seeds page › **Sync** › paste your personal Seeds API key (from your Seeds profile) › **Connect Seeds**. It syncs straight
away and every 30 minutes after. The key is stored encrypted, tied to you, and never shown again (only its last four
characters). **Disconnect** removes the key and the access that came from it.

The Administrator sees who has connected, and how each person's last sync went, in Settings › Integrations › Seeds.

## Turn on per-person visibility

Settings › **Access**. Visibility is off by default, so connecting Seeds changes nothing about who sees what until an
Administrator turns it on. Until someone connects their Seeds, the assignments entered in Settings › Access (if any)
apply to them; with none, they see an empty workspace and are asked to connect.

Which pages each person gets comes from their **job roles** (Settings › Roles): picked in Users & Permissions, and
from Seeds per client or project. Each role lists the titles Seeds uses for it; titles no role claims are listed in
Settings › Integrations › Seeds. **Administrators see and change everything**, assigned or not.

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

## What Seeds sends, and how it is read

Each person's sync reads, with `Authorization: Bearer <their key>`:

`<address>/clients`, `/projects`, `/tasks`, `/assignments`, and if Seeds has them, `/me` (who the key belongs to) and
`/people`.

A list can be a bare JSON array or `{ "data": [...], "next": "<next page>" }`. Field names are read leniently
(`id`/`client_id`, `name`/`project_name`, `contract_number`/`contractNumber`, `person_id`/`user_id`, role as `BA`, `PM`,
`AM` or the full title). Only the key owner's own assignments count: found by `/me`, else by their email in `/people`;
if assignments name no person at all, everything the key returns is the owner's. If Seeds' real API differs, only
[`server/seeds/seeds-client.ts`](../../server/seeds/seeds-client.ts) needs to change.

## When Seeds is down

That person's last synced access stays in force and the Seeds page shows when Seeds was last read. Nothing is deleted
when a record disappears from Seeds: work that is not in Seeds keeps working.

## Turning Seeds off

Settings › Integrations › Seeds › **Turn off**. Hand-entered assignments count again; people's keys and the Seeds links
on records stay, so turning it back on picks up where it left off.
