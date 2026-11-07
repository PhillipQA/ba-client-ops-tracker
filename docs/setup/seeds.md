# Seeds

Seeds is the company's time and client tracker. Connected, it decides **who sees which client and project**; this app
keeps the subtasks, emails, trackers, documents and time.

## Before you connect

1. Run [`database/migrations/schema-v36-seeds.sql`](../../database/migrations/schema-v36-seeds.sql) once on the live
   database (a new database already has it).
2. Make sure each person's **email in Users & Permissions is the same as in Seeds**. People are matched by email.

## Connect

Settings › Integrations › **Seeds**: enter the Seeds API address (https only) and the API key, then **Connect Seeds**.
Saving the key turns Seeds on: it syncs straight away and every 30 minutes after. The key is stored encrypted and never
shown again (only its last four characters).

## Turn on per-person visibility

Settings › **Access**. Visibility is off by default, so connecting Seeds changes nothing about who sees what until an
Administrator turns it on. Check the **Seeds › Sync** tab first: confirm close matches and look at *People in Seeds
without an account here*, or those people will see an empty workspace.

| Role in Seeds | Sees | Can change | Pages |
|---|---|---|---|
| Business Analyst (BA) | Assigned clients or projects and all work under them | Yes | As their account allows |
| Project Manager (PM) | Projects they manage, including their BAs' work | Yes; also confirms Seeds matches | As their account allows |
| Account Manager (AM) | What they are assigned | No (Viewer) | Action Center, Reports, AI BA Assistant, My Themes |
| Administrator (app role) | Nothing of clients unless assigned | Settings and Users | All their modules |

Roles add up per project. A project assignment does not open the rest of its client: the client shows by name only.

## What Seeds sends, and how it is read

The app reads five lists, each with `Authorization: Bearer <key>`:

`<address>/people`, `/clients`, `/projects`, `/tasks`, `/assignments`

A list can be a bare JSON array or `{ "data": [...], "next": "<next page>" }`. Field names are read leniently
(`id`/`client_id`, `name`/`project_name`, `contract_number`/`contractNumber`, `person_id`/`user_id`, role as `BA`, `PM`,
`AM` or the full title). If Seeds' real API differs, only [`server/seeds/seeds-client.ts`](../../server/seeds/seeds-client.ts)
needs to change.

## When Seeds is down

The last synced assignments stay in force and the Seeds page shows when Seeds was last read. Nothing is deleted when a
record disappears from Seeds: work that is not in Seeds keeps working.

## Disconnect

Settings › Integrations › Seeds › **Disconnect**. Hand-entered assignments (Settings › Access) count again; the Seeds
links on records stay, so reconnecting picks up where it left off.
