# End-to-end tests

Playwright drives the real app (built, `npm start`) in Chromium against a real database. Each test makes its own
uniquely named records, and the tests run one at a time.

| Test | What it checks |
| --- | --- |
| `01-sign-in` | Account step, wrong password, sign-in, sign-out |
| `02-internal-admin` | Internal Admin at `/internal_admin`, the forced password change, the accounts list |
| `03-clients-projects` | Add a client and a project |
| `04-tasks` | Create, edit, complete and archive a task |
| `05-subtasks` | Add a subtask; closing the task asks to close it too |
| `06-task-views` | The same task in the Table, Board, Calendar and Timeline views |
| `07-action-center` | A task due today is in the Morning brief; the Needs attention count lists it |
| `08-trackers` | Create a tracker, add a row, type a cell |
| `09-users` | Add a Contributor in Users & Permissions |
| `10-settings-workflow` | Add a task status; the task form offers it |
| `11-pages` | Work Hub, RTM, Documents, Reports and My Themes open |

## Screenshots

Each test saves screenshots of its steps in `e2e/screenshots/<test>/` (JPEG, to keep the repository small). In CI ([e2e.yml](../.github/workflows/e2e.yml))
the tests run headed (a real browser window on a virtual display) on a fresh database, and the new screenshots are
committed to the pull request's branch, so the PR shows what changed and they stay in git. The full report, traces
and videos of failures are in the run's **e2e-report** artifact.

## Running them yourself

Use an empty database of your own, never a live one: the tests add clients, tasks and users.

1. Create it: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql`.
2. Set the server's settings (`DATABASE_URL`, `TENANT_INTEGRATION_MASTER_KEY`, `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD`,
   `BXI_CORE_BOOTSTRAP_PASSWORD`, `APP_BASE_URL=http://localhost:5173`).
3. `npm run build`, then `npx playwright install chromium` once.
4. `npm run e2e:headed` to watch the browser, or `npm run e2e` without a window.

The tests start the app themselves. To use one that is already running, set `E2E_BASE_URL`. A workspace whose
Administrator password was changed can be used with `E2E_ACCOUNT`, `E2E_USER` and `E2E_PASSWORD`.
