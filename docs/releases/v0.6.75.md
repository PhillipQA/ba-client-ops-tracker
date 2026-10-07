# BA Client Ops Tracker v0.6.75 — Work Hub and personal GitHub tickets

Upgrade from v0.6.74 using the matching patch. A full build is available for a fresh installation. This release includes one new database migration; run it before starting the updated app.

## What changed

- Renamed **Communications Hub** to **Work Hub** in navigation and Gmail setup guidance.
- Work Hub now has exactly four source tabs: **Email, Discord, GitHub, Manual Logs**. Email continues using the existing Gmail connection. Active/Archived filtering is available within the email, Discord and manual-log views. Existing shared inquiries remain available below the Hub in a collapsed section.
- Each user can connect their own **GitHub personal access token** inside **Work Hub → GitHub → My GitHub settings**. Tokens are validated against GitHub and encrypted on the server with tenant and user binding. No token is returned to the browser after saving or put into shared workspace data.
- Select up to 20 repositories accessible to your token. Repository discovery supports pagination, and you can also enter `owner/repository`. Optionally map each repository to a client and project to prefill task creation.
- GitHub imports issues **created by your GitHub account or assigned to it**, combines both views without duplicate records, and excludes pull requests. Open issues have no age cutoff. Closed issues updated in the last 30 days are also imported. Previously imported open issues that disappear from those filters are checked individually for closure, reassignment or removal.
- The ticket table has **All my tickets, Assigned to me, Created by me**, title search, repository/state/label/QA filters and pagination of 5/10/15 rows, starting at 5.
- Ticket details show the description, labels, creator, assignees, milestone when supplied, latest comment, client/project mapping and an **Open in GitHub** link.
- Personal QA statuses are **Not started, In progress, Needs retest, Passed, Failed, Blocked**. They remain independent of GitHub open/closed state and task completion, and are preserved during sync.
- **Create task** lets you review the shared title and description and choose the client, project and assignee. GitHub comments, credentials and private source identifiers are not automatically copied. **Copy ticket description into shared task** is an explicit choice. Creating the same linked task again is prevented.
- **Link existing task** supports tasks and subtasks, with change/unlink options. A task link stays private to the user who imported the ticket.
- GitHub sync runs when the GitHub tab is opened and every five minutes while the tab is visible, online, connected and settings are closed. **Sync now** is available. Large imports continue in bounded batches; GitHub rate limits pause requests and give retry guidance. This is polling while Work Hub is open, not a server-side background worker or webhook subscription.
- Disconnecting removes the stored token and stops sync; imported tickets and local QA/task links remain private. Connecting a different GitHub account resets repository selection and keeps its cache separate from the previous account.
- Existing Gmail/Discord behavior and the v0.6.74 custom FSD feature improvements remain in the build. No new npm dependencies are needed. The existing `inbox` module permission now appears as Work Hub, so users do not need new module assignments.

## Upgrade an existing v0.6.74 installation

1. From the project folder, apply the matching patch:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.75-work-hub-github.zip"
```

2. Before starting v0.6.75, open **Supabase → SQL Editor** and run the entire **`database/migrations/schema-v19-work-hub-github.sql`** file once. A separate copy accompanies this release. It creates two private tables and does not change existing Gmail, Discord, document or workspace rows.
3. Build and check the server:

```powershell
npm run build
npm run typecheck:server
```

4. Restart or redeploy the app and refresh the browser. Confirm the displayed version is **0.6.75**.

Keep your existing environment configuration and **`TENANT_INTEGRATION_MASTER_KEY`**. GitHub uses the same server encryption infrastructure as the other integrations. If that variable is missing, configure a 64-character hex key on the server before connecting GitHub. Do not replace an existing key; it is needed to decrypt existing integration credentials.

The patch includes `patch-manifest.json`, upgrades exactly v0.6.74 and includes deletion of the replaced `src/CommunicationsHub.tsx` component. Do not force it onto another version.

For a fresh installation, extract the full build, follow the README and `.env.example`, run `npm ci`, and use `database/setup.sql` only with a new empty Supabase database. The fresh setup now contains 19 migrations / 32 tables. Do not run fresh setup on an existing database.

## Connect your GitHub account

1. On GitHub, open **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, or visit https://github.com/settings/personal-access-tokens/new.
2. Create a token with an expiry suitable for your workflow. Select the correct resource owner and repositories. For private repository issues, grant **Repository permissions → Issues → Read-only**. Metadata access is supplied automatically. Organizations may require approval or SSO authorization. A token can read only repositories it is permitted to access; a fine-grained token has one resource owner. Classic personal tokens are also accepted when your organization allows them.
3. In the tracker, open **Work Hub → GitHub → My GitHub settings**, paste your own token and click **Connect GitHub**. The connected GitHub username is detected from the token, rather than entered manually.
4. Load repositories or add `owner/repository`, select the repositories to monitor, and optionally choose a client/project for each. Click **Save my repositories**. Sync begins when settings close; **Sync now** can also start or continue it.
5. Use **Assigned to me** or **Created by me** to find your tickets. A ticket appearing in both views is stored once. If no tickets appear, check the repository selection, filters, connected username, token expiry and organization permissions.

GitHub is read only in this release. Use **Open in GitHub** for ticket replies, changes and closing issues. The tracker saves local QA status and task links without writing back to GitHub.

GitHub documentation: https://docs.github.com/en/rest/issues/issues and https://docs.github.com/en/rest/repos/repos.

## Deployment checks

- User A connects their token and imports a known created/assigned issue. User B should see only their own connection and imports, including when User B is an administrator.
- Check an old unresolved issue and a recently closed issue. Confirm that each is imported into the right view without pull requests or duplicate records.
- Set **Needs retest**, link a subtask, and sync again. QA status and task link must remain unchanged even if GitHub closes the issue.
- Create a task for another user with a reviewed shared description. Confirm that the task contains only submitted fields and does not expose the original ticket comments or token.
- Remove a repository, disconnect, and reconnect. Confirm that the scope and cached-ticket behavior match the descriptions above.
- Verify Gmail labels, automatic Gmail sync, Discord capture, manual logs and Archived filtering still work in their tabs.

## Validation

- Production build and server TypeScript check passed.
- Functional regression command: **77 tests passed**, including **13 GitHub tests**, plus route assertions for AI adapters, document generation/export and workspace saves.
- Existing full Gmail/Discord communications suite: **6 tests passed**.
- GitHub tests cover encrypted personal tokens, user/tenant/account isolation, repository validation and pagination, created/assigned issue union, old open issues, pull-request exclusion, resumed imports, QA/link preservation, closure/reassignment reconciliation, latest comments, rate limits, revoked tokens, task/subtask linking, duplicate task prevention, failed/lost task commits and Work Hub markup.
- Database bundle consistency check passed: **19 migrations / 32 tables**. The migration was not executed against a live Supabase database during this build.
- ZIP integrity, exact patch payload and patch application/build on an isolated v0.6.74 copy were verified.

GitHub and other external APIs were tested with simulated responses. No live GitHub token was supplied. The UI was rendered in automated checks; an interactive browser check was unavailable. Complete the deployment checks above after applying the migration and build.
