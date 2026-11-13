# Repository structure

## Frontend (`src/`)

| Path | Contents |
| --- | --- |
| `src/main.tsx` | Entry point: loads the global styles and renders the app |
| `src/app/` | `App.tsx` (sign-in checks, the menu, which page shows), `useAppState.tsx` (all app state and actions, built from the hooks in `src/app/state/`), `store.ts` (store types, storage and normalising), cloud sync, polling, sign-in screens, profile dialog, navigation |
| `src/app/state/` | The hooks `useAppState` calls, in this order: `useUiState` (screen state), `useCloudSync`, `useWorkspaceSave` (`persist`), `useSignIn` (the signed-in person and their rights), `useAccountAndRoutes` (notifications, page address, profile), `useWorkViews` (filtered lists, Action Center), `useTaskActions`, `useTrackerTasks`, `usePlanner`. Each takes what it needs from the ones before it; keep that order so hooks and effects run the same way |
| `src/features/<area>/` | One folder per part of the app: `action-center`, `clients`, `inbox`, `tasks`, `trackers`, `email`, `work-hub`, `integrations` (Gmail, Drive, Calendar, Git), `documents` (BRD, FSD, test cases, sign-offs, DocHub, Drive), `requirements`, `notifications`, `reports`, `ai`, `settings`, `accounts`, `admin`. A feature keeps its components, model code and CSS together |
| `src/shared/` | Used by several features: `types.ts`, `dates.ts`, `businessDate.ts`, `version.ts`, contact search, and `http.ts` (`requestJson`, the one way to call the API) |
| `src/shared/ui/` | The UI kit: `Dialog`, `Popover`, `Notice`, `SearchSelect`/`ClientSelect`, `Chips`, person and recipient inputs, `useModalDialog`, and `ui.css` (the `--k-*` tokens and `k-` classes) |
| `src/styles/` | Global styles, interface modes, the sidebar and the bundled Inter font. `styles.css` lists its parts in `src/styles/app/` in the order they apply: add rules to the part they belong to, and a new part where it belongs in that list |

Pages receive the app state as one `app` prop (`AppState` from `src/app/useAppState.tsx`) and take the values they need from it.

## Server (`server/`)

| Path | Contents |
| --- | --- |
| `server.ts` | Stable entry point; starts `server/index.ts` |
| `server/index.ts` | Wires middleware and registers every route group, in order |
| `server/core/` | `env.ts` (loads `.env` files first), `config.ts`, `database.ts` (the PostgreSQL client, `db`), `constants.ts`, `services.ts` (integration settings and AI agents), `auth.ts` (sessions, passwords, `requireAuth`, `requireTenantWorkspace`), `tenant-state.ts` (loading and saving each organisation's workspace) |
| `server/<area>/` | Route modules, each exporting `register…Routes(app)` or taking its dependencies: `auth`, `workspace`, `platform` (internal admin, settings, static site), `ai`, `documents`, `integrations`, `trackers`, `tasks`, `accounts`, plus `services` for shared business rules |
| `server/trackers/` | `trackers.ts` registers the tracker routes from its parts: `tracker-core` (access, shaping trackers and rows, history), `tracker-source` (the connected Sheet or Excel file), `tracker-sync`, `tracker-sheet-write`, `tracker-follow` (rows and tasks kept in step), `tracker-seeds-rows` (rows for new Seeds projects), and the route groups `tracker-source-routes`, `tracker-routes`, `tracker-column-routes`, `tracker-row-routes` |
| `server/ai/` | The AI BA Assistant (`assistant-routes` and its `assistant-*` parts), the AI Agent Manager, `tenant-ai` (calls the account's AI provider) and `brief-routes` (the morning brief and the weekly status report). The brief's and the report's facts are counted in `src/features/ai/brief.ts` and `statusReport.ts`, which the browser shares; the AI only words them |
| `server/integrations/communications*.ts` | Work Hub messages: `communications.ts` registers `communications-core` (access, Gmail settings, Google access), `-gmail-settings`, `-messages`, `-tasks` (message to task) and `-gmail` (connect and sync) |

## Other paths

| Path | Contents |
| --- | --- |
| `database/` | `schema.sql`, which sets up a new PostgreSQL database; later schema changes go in `migrations/` |
| `templates/` | Controlled document-generation templates |
| `public/` | Static browser assets |
| `scripts/` | The functional-check runner and the CI test and lint summaries |
| `tests/` | Automated regression checks (`npm test`) |
| `docs/setup/` | Google setup, password recovery and Sign Off mapping (installation and deployment are in the README) |
| `biome.json` | Formatting and lint settings |
| `README.md`, `CHANGELOG.md`, `.env.example` | Installation, recent changes, safe configuration template |

## Conventions

1. Keep setup and deployment guidance in the README; put longer guides in `docs/setup/`.
2. Add each change to the top of `CHANGELOG.md`, saying whether the database changes and what to run.
3. Database changes: add `database/migrations/schema-vNN-<what>.sql` for existing databases and fold the same change into `database/schema.sql` (see [database/README.md](../../database/README.md)).
4. Keep environment secrets, builds, dependencies and logs out of source control.
5. New screens and their code go in a feature folder; move code to `src/shared/` only once a second feature needs it.
6. Call the API through `src/shared/http.ts` and build dialogs and popovers from `src/shared/ui`.
7. Run `npm run format` before committing; CI runs `npm run check`.

See the [documentation index](../README.md).
