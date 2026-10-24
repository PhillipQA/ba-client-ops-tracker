# Repository structure

## Frontend (`src/`)

| Path | Contents |
| --- | --- |
| `src/main.tsx` | Entry point: loads the global styles and renders the app |
| `src/app/` | `App.tsx` (sign-in checks, the menu, which page shows), `useAppState.tsx` (all app state and actions), `store.ts` (store types, storage and normalising), cloud sync, polling, sign-in screens, profile dialog, navigation |
| `src/features/<area>/` | One folder per part of the app: `action-center`, `clients`, `inbox`, `tasks`, `trackers`, `email`, `work-hub`, `integrations` (Gmail, Drive, Calendar, Git), `documents` (BRD, FSD, test cases, sign-offs, DocHub, Drive), `requirements`, `notifications`, `reports`, `ai`, `settings`, `accounts`, `admin`. A feature keeps its components, model code and CSS together |
| `src/shared/` | Used by several features: `types.ts`, `dates.ts`, `businessDate.ts`, `version.ts`, contact search, and `http.ts` (`requestJson`, the one way to call the API) |
| `src/shared/ui/` | The UI kit: `Dialog`, `Popover`, `Notice`, `SearchSelect`/`ClientSelect`, `Chips`, person and recipient inputs, `useModalDialog`, and `ui.css` (the `--k-*` tokens and `k-` classes) |
| `src/styles/` | Global styles, interface modes, the sidebar and the bundled Inter font |

Pages receive the app state as one `app` prop (`AppState` from `src/app/useAppState.tsx`) and take the values they need from it.

## Server (`server/`)

| Path | Contents |
| --- | --- |
| `server.ts` | Stable entry point; starts `server/index.ts` |
| `server/index.ts` | Wires middleware and registers every route group, in order |
| `server/core/` | `env.ts` (loads `.env` files first), `config.ts`, `database.ts`, `constants.ts`, `services.ts` (integration settings and AI agents), `auth.ts` (sessions, passwords, `requireAuth`, `requireTenantWorkspace`), `tenant-state.ts` (loading and saving each organisation's workspace) |
| `server/<area>/` | Route modules, each exporting `register…Routes(app)` or taking its dependencies: `auth`, `workspace`, `platform` (internal admin, settings, static site), `ai`, `documents`, `integrations`, `trackers`, `tasks`, `accounts`, plus `services` for shared business rules |

## Other paths

| Path | Contents |
| --- | --- |
| `database/` | Fresh Supabase setup, incremental migrations and selected combined upgrades |
| `templates/` | Controlled document-generation templates |
| `public/` | Static browser assets |
| `scripts/` | Patch tools, functional-check runner, database helpers, and the CI test and lint summaries |
| `tests/` | Automated regression checks (`npm test`) |
| `docs/setup/` | Current installation, hosting and maintenance guides |
| `docs/releases/` | Version-specific release notes; `archive/` holds superseded instructions |
| `biome.json` | Formatting and lint settings |
| `README.md`, `CHANGELOG.md`, `.env.example` | Installation, recent changes, safe configuration template |

## Conventions

1. Keep current setup guidance in the README and `docs/setup/`.
2. Keep a short newest-first changelog; link detailed version notes instead of repeating them.
3. Put release notes in `docs/releases/vX.Y.Z.md`. Do not add root `UPGRADE-*.md` or legacy patch-note files.
4. Preserve older instructions in the release archive; label superseded behavior when relevant.
5. Put database migrations in `database/migrations/`. Regenerate fresh setup with `npm run db:bundle` and check it with `npm run db:check`.
6. Keep source updates and official version-matched patch ZIP workflows distinct.
7. Publish generated ZIPs as release assets rather than committing them to Git.
8. Keep environment secrets, local patch backups, builds, dependencies and logs out of source control.
9. New screens and their code go in a feature folder; move code to `src/shared/` only once a second feature needs it.
10. Call the API through `src/shared/http.ts` and build dialogs and popovers from `src/shared/ui`.
11. Run `npm run format` before committing; CI runs `npm run check`.

See the [documentation index](../README.md) and [release index](../releases/README.md).
