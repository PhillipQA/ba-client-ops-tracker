# Seeds Open API — reference

Source: the Seeds API documentation page (`https://seeds.iripple.com/employee/api-documentation`, behind iRipple Google sign-in), copied 2026-11-08. Seeds marks this as an **experimental SEEDS v2 feature**. The page also links a machine-readable **OpenAPI 3.1 JSON** contract (signed-in only); its details are folded in below.

## Connecting

- **API URL:** `https://seeds.iripple.com/api/v1/`
- **Access is per application, not per person.** Ask a SEEDS Admin for an **application token** and list the exact operations (permission names below) the app needs. Read access is the default; every write action is approved separately.
- **Application token** — identifies and authorizes the app. Send it as `Authorization: Bearer <application-token>`.
  - Keep it only in backend environment variables. **Never** put it in code, a mobile or browser bundle, a public repo, logs or screenshots. Seeds Admin may audit the code.
- **Reads** need only the application token.
- **Writes** (create, update, delete, cancel) need the application token **and** a current Google ID token for the employee making the change, sent as `X-SEEDS-Google-ID-Token: <google-id-token>`.
  1. Register the app's Google OAuth client IDs with Seeds Admin when asking for write permissions.
  2. Sign the employee in with Google Identity Services and get a Google ID token for one of those client IDs.
  3. Send both tokens on every write. Do not send a user ID or email to act as someone else.
  4. Seeds checks the token signature, issuer, expiry, audience, verified Google-hosted email, active employee record and stable Google identity, then applies its normal rules.
  - Google ID tokens are short-lived proof of who is acting; they do not replace the application token.
- **Retries:** send a unique `Idempotency-Key` header on every create or cancel. Reuse the same key when retrying the same request.
- **Errors:** check the HTTP status and the structured error body. Requests are rate-limited (429) and audited.

## Shapes (from the OpenAPI contract)

- **Every success** is `{ "data": … }`. The contract does not describe the records inside `data`, so their field names are not published.
- **Every error** is `{ "error": { "code", "message", "requestId"?, "details"? } }`, with status 400, 401, 403, 404, 409 or 429.
- **Lists are cursor-paged:** `?limit=` (1–100, default 50) and `?cursor=` (the opaque `nextCursor` from the previous answer). Applies to `/users`, `/clients`, `/parents`, `/projects`, `/prospects`, `/proposals`, `/contracts`, `/service-agreements`, `/project-templates`. Sub-lists such as `/projects/{id}/members` take no paging.
- **Ids** in paths are integers ≥ 1.
- **Workforce reads** take `subjectUserId` or `subjectEmail` (the employee); `/time-entries` also needs `fromDate` and `toDate` (YYYY-MM-DD).
- **`Idempotency-Key`** is required on every create and cancel (8–191 characters, kept 24 hours).

Write bodies:

| Body | Required | Optional |
|---|---|---|
| Time entry | `postDate` (date), `projectId`, `minuteslogged` (multiple of 15, at least 15) | `taskId`, `parentId`, `clientId`, `productId`, `remarks` |
| Leave request | `postDate`, `leaveTypeId`, `minuteslogged` (240 or 480), `remarks` | |
| Overtime request | `postDate`, `projectId`, `minuteslogged` (≥ 1), `remarks` (1–120 chars) | `taskId`, `parentId`, `productId` |

## Operations

All paths are under `/api/v1`. All list/get calls are `GET`.

### Core & reference
| Endpoint | What | Permission |
|---|---|---|
| `/departments` | List departments | `core.departments.read` |
| `/products` | List products | `core.products.read` |
| `/statuses` | List status reference data | `core.statuses.read` |
| `/periods` | List operational and revenue periods | `core.periods.read` |
| `/users` | Minimal active-user directory | `core.users.read` |

### Sales & pipeline (read only)
| Endpoint | What | Permission |
|---|---|---|
| `/prospects`, `/prospects/{prospectId}` | Prospects | `sales.prospects.read` |
| `/prospects/{prospectId}/contacts` | Prospect contacts | `sales.contacts.read` |
| `/proposals`, `/proposals/{proposalId}` | Proposals | `sales.proposals.read` |
| `/prospects/{prospectId}/interactions` | Prospect interactions | `sales.interactions.read` |

### Customers & contracts (read only)
| Endpoint | What | Permission |
|---|---|---|
| `/parents`, `/parents/{parentId}` | Parents (customer groups) | `customers.parents.read` |
| `/parents/{parentId}/clients` | Clients for a parent | `customers.clients.read` |
| `/clients`, `/clients/{clientId}` | Clients | `customers.clients.read` |
| `/parents/{parentId}/interactions` | Customer interactions | `customers.interactions.read` |
| `/contracts`, `/contracts/{contractId}` | Contracts | `customers.contracts.read` |
| `/service-agreements`, `/service-agreements/{agreementId}` | Service agreements | `customers.service_agreements.read` |

### Projects & delivery (read only)
| Endpoint | What | Permission |
|---|---|---|
| `/projects`, `/projects/{projectId}` | Projects | `projects.projects.read` |
| `/projects/{projectId}/tasks` | Tasks of a project | `projects.tasks.read` |
| `/projects/{projectId}/members` | Members of a project | `projects.members.read` |
| `/projects/{projectId}/milestones` | Milestones of a project | `projects.milestones.read` |
| `/project-templates`, `/project-templates/{templateId}` | Project templates | `projects.templates.read` |
| `/projects/{projectId}/statistics` | Project delivery statistics | `projects.statistics.read` |

### Workforce self-service (employee-scoped)
| Method | Endpoint | What | Permission | Google sign-in |
|---|---|---|---|---|
| GET | `/time-entries`, `/time-entries/{entryId}` | Time entries | `workforce.time_entries.read` | |
| POST | `/time-entries` | Create time entry | `workforce.time_entries.create` | required |
| PATCH | `/time-entries/{entryId}` | Update time entry | `workforce.time_entries.update` | required |
| DELETE | `/time-entries/{entryId}` | Soft-delete time entry | `workforce.time_entries.delete` | required |
| GET | `/leave-requests`, `/leave-requests/{entryId}` | Leave requests | `workforce.leave.read` | |
| POST | `/leave-requests` | Create leave request | `workforce.leave.create` | required |
| PATCH | `/leave-requests/{entryId}` | Update leave request | `workforce.leave.update` | required |
| POST | `/leave-requests/{entryId}/cancel` | Cancel leave request | `workforce.leave.cancel` | required |
| GET | `/overtime-requests`, `/overtime-requests/{entryId}` | Overtime requests | `workforce.overtime.read` | |
| POST | `/overtime-requests` | Create overtime request | `workforce.overtime.create` | required |
| PATCH | `/overtime-requests/{entryId}` | Update overtime request | `workforce.overtime.update` | required |
| POST | `/overtime-requests/{entryId}/cancel` | Cancel overtime request | `workforce.overtime.cancel` | required |

## Projects API additions (Seeds, 2026-11-13)

- `/projects` records carry **`updatedAt`**, and `GET /projects?updatedSince=<ISO time>` returns only projects created, changed or deleted since then (still cursor-paged). Deleted projects come back with a **deletion indicator**.
- A change to a project's **members or tasks** also marks the project updated, so a delta sync only needs members and tasks for the projects that delta returns.
- Projects carry the **contract number/reference**, the **project status**, and **project-level time-entry requirements and defaults** (e.g. whether a product is required, default product/task). These replace the separate `/statuses` and `/contracts` permissions, which Seeds did not grant.
- Project **members include email and organizational role**. There is no separate project-member role and no `createdAt`.
- The app's token has `core.products.read` and is limited to **20 requests per minute**. The app reads `GET /products` in each full sync (and in a delta when a change names an unknown product). Some Seeds projects and Seeds tasks require a product on time entries: the task's picked product is sent, else the project's, else Seeds' default, and time that still has none is not sent.
- The updated employee API documentation page has examples and synchronization guidance; field names in this app are read leniently until checked against it (Settings › Integrations › Seeds shows the names Seeds sent, including one level inside objects).

How this app syncs: a **delta sync** every 10 minutes (`updatedSince` = the latest `updatedAt` from the last sync, minus 10 minutes of overlap), and a **full sync** once a week or when someone clicks Full sync. If Seeds turns down `updatedSince`, that sync reads everything instead.

### A project as Seeds sends it (`GET /projects/{id}`, 2026-11-13)

```json
{
  "id": 1059, "name": "GOLDWING BALABALA", "isDeleted": false, "updatedAt": "2026-11-13T02:09:02.672Z",
  "projectStatus": { "id": 4, "name": "Completed" },
  "parent": { "id": 223, "name": "Goldwing Retail Group Inc." },
  "client": { "id": 0, "name": "-" },
  "product": { "id": 0, "name": "" },
  "contractId": 1660, "contractLineItemId": 1850, "contractNumber": "CONTRACT-2026-04-1660",
  "timeEntryRequirements": { "task": true, "parent": true, "client": false, "product": true, "remarks": true },
  "timeEntryDefaults": { "parentId": 223, "clientId": null, "productId": null }
}
```

Also sent: `description`, `accessScope`, `isPmoTracking`, `isBillable`, `isNoOvertime`, `allotedManHours`, `remainingManHours`, `estCompletionDate`, `completionDateActual`, `workClassification`, `user` (`id`, `email`) and `department` (`id`, `name`).

How the app reads it:
- **`id: 0` means none.** A project with no client or product sends `{ "id": 0 }`.
- **`parent`** is the app's client. **`contractNumber`** goes on the project and fills tracker contract columns and the DRF's Contract Number.
- **`projectStatus.name`** of Completed, Closed, Cancelled and similar closes the project here. **`isDeleted: true`** does too.
- **`timeEntryRequirements`** says what a time entry must carry. **`timeEntryDefaults.parentId`** is the parent sent when the project has no client linked here.

## What this app needs (read only)

To ask Seeds Admin for: `core.users.read`, `customers.parents.read`, `projects.projects.read`, `projects.members.read`, `projects.tasks.read`, and `customers.clients.read` (used only when a project names a Seeds client instead of its parent). Setup steps: [setup/seeds.md](setup/seeds.md).

## Still unknown

- The record fields (Seeds does not publish them). The app reads them leniently and, after a sync, shows the field names Seeds sent in Settings › Integrations › Seeds.
- Whether `/users` includes email and job title, and whether `/projects/{id}/members` includes each member's role on the project.
