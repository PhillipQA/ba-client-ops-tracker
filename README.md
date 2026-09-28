# BA Client Ops Tracker

**Current release: v0.6.58**

BA Client Ops Tracker is a multi-tenant Business Analyst and client-operations workspace for managing clients, projects, tasks/subtasks, follow-ups, inquiries, activities, communications, document workflows, reporting and AI-assisted BA work.

Built with **React + TypeScript + Vite**, an **Express** backend, **Supabase**, Discord integration, DocHub, Google Calendar, local OCR and tenant-configured AI providers.

Upgrade details: [v0.6.58 release notes](docs/releases/v0.6.58.md). For personal interface modes, see [v0.6.42](docs/releases/v0.6.42.md). For Document Agent RTM mapping, see [v0.6.41](docs/releases/v0.6.41.md); for initial RTM activation, see [v0.6.40](docs/releases/v0.6.40.md).

## Main modules

- **Action Center** — assigned work, follow-ups, activities and workload views.
- **Clients & Projects** — shared project structure with tenant/client history.
- **Requirements & Traceability** — client-specific RTMs, optional Document Agent mapping from your BRD/FSD/test cases, reviewed source references, task/subtask progress, coverage, impact review and Excel export. Assignment and task linking stay manual.
- **Tasks & Subtasks** — assignment, dates, follow-up, comments, evidence and lifecycle tracking.
- **Communications Hub** — user-owned Gmail and Discord messages, manual communications, selective task creation, and existing shared inquiry handling.
- **Document Creation** — DRF, FSD, Test Case and Sign-Off workflows.
- **Document History** — compact Active/Archive tracking for DocHub documents.
- **Reports** — project/task/user workload and activity reporting.
- **AI Agent Manager** — separate BA Assistant and Document Agent configuration per tenant.
- **Settings & Appearance** — organized account controls and personal Dark, Light, or Gray interface modes, independent of background themes and document templates.
- **Internal Admin** — tenant/account/module/platform administration.

## Integrations

- Supabase
- Discord
- Gmail (per-user OAuth, selected-label manual sync)
- DocHub
- Google Calendar
- Gemini / OpenAI-compatible AI providers

Integration credentials are tenant-scoped where supported. Secrets must not be committed to Git.

## Repository map

```text
ba-client-ops-tracker/
├── database/       Supabase migrations
├── docs/           Architecture, setup and release notes
├── public/         Static browser assets
├── scripts/        Patch / rollback tooling
├── server/         Express backend
├── src/            React frontend
├── templates/      Controlled document templates
├── tests/          Automated tests
├── README.md
├── server.ts       Stable server entry point
└── package.json
```

See [`docs/architecture/REPOSITORY-STRUCTURE.md`](docs/architecture/REPOSITORY-STRUCTURE.md) for the full organization rules.

## Quick start

Requirements: **Node.js 22+** and npm.

```bash
npm ci
npm run dev
```

Production validation:

```bash
npm run build
npm run typecheck:server
```

The application reads local environment values from `.env.local` / `.env`; use `.env.example` as the safe template. Never commit real secrets.

## Database

**New Supabase database:** run [`database/setup.sql`](database/setup.sql) once in SQL Editor. It includes the complete schema through v15.

**Existing database:** use only the newer migrations required by your release. Moving the app server while retaining the same Supabase project needs no database SQL. See [Deploy on a new server](docs/setup/deploy-new-server.md).

See [`database/README.md`](database/README.md).

## AI architecture

The application separates AI responsibilities through an **AI Agent Manager**:

```text
AI Agent Manager
├── BA Assistant       conversational BA/workspace support
└── Document Agent     requirement extraction, FSD/test/document workflows
```

Each tenant can configure the supported provider/model/credential for these agents independently, with legacy shared AI configuration retained as a compatibility fallback where applicable.

## Patch workflow

To apply an official patch:

```bash
npm run patch -- "C:\path\to\ba-client-ops-patch-vX.Y.Z.zip"
npm run patch:status
npm run build
```

Rollback the most recently applied patch when necessary:

```bash
npm run patch:rollback
```

Patch runtime backups are stored locally under `.patch-backups/` and are ignored by Git.

## Documentation

- [Documentation index](docs/README.md)
- [Repository structure](docs/architecture/REPOSITORY-STRUCTURE.md)
- [Setup guides](docs/setup/)
- [Release notes](docs/releases/)
- [v0.6.39 upgrade notes](docs/releases/v0.6.39.md)

## Releases and generated ZIPs

Keep Git focused on source code and documentation. Full-build and patch ZIPs should be published as **GitHub Release assets**, not committed into the repository.

## Current release highlights

**v0.6.58** makes FSD preview prerequisites visible beside the preview button. Upload and AI source review can finish before document details are entered. The screen also displays the running app version to help distinguish an old deployment.

**v0.6.57** adds automatic AI source review when uploading FSD files or adding pasted notes. Each source shows readability, interpreted facts with original excerpts, and clarification questions. FSD generation combines the current reviewed sources, preset, guidance and checked scope. Source changes require reanalysis; unchanged reviews are reused.

**v0.6.56** hard-enforces Advanced Mode FSD module scope. Unchecked software modules are removed from the AI section schema, omitted from preview and Word export, and sources mapped only to unchecked modules are excluded from FSD AI generation.

**v0.6.53** adds image support to FSD Creation. PNG, JPG/JPEG, WEBP, BMP, TIF and TIFF uploads are OCR-read and added to the FSD source list as Supporting document sources. Existing document-source handling is unchanged.

For earlier changes, see the versioned files under [`docs/releases/`](docs/releases/).
