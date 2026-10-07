# BA Client Ops Tracker v0.6.76 — GitHub / GitLab provider dropdown

## What changed

- Work Hub has Email, Discord, **GitHub / GitLab**, and Manual Logs. Inside the Git tab, choose **Ticket provider → GitHub or GitLab**.
- Each user saves their own token for each provider. Existing GitHub connections, repository mappings, QA status and task links are retained. Switching the dropdown keeps the two connections and ticket caches separate.
- GitLab supports `https://gitlab.com` or a company GitLab HTTPS website URL, including installations under a subpath. Enter the website URL without `/api/v4`.
- GitLab project discovery lists projects you belong to. You can also enter `group/project` or `group/subgroup/project` manually if your token can access it. Select up to 20 projects and optionally map each to a tracker client/project.
- Sync imports issues created by or assigned to the connected GitLab user. The union is deduplicated. Old unresolved issues have no date cutoff; closed issues updated in the last 30 days are included. Previously imported open issues are checked individually when they disappear from the filters.
- GitLab descriptions, assignees, labels, milestones and recent user comments appear in the detail panel. Project issue IID is used for display and links. System activity notes are skipped; up to 100 recent notes are inspected to find the latest user comments.
- All my tickets, Assigned to me, Created by me, search, state/repository/label/QA filters, 5/10/15 pagination, QA status, task creation and task/subtask linking work with either provider.
- QA status and task links remain personal and survive sync. They do not change the Git provider’s issue state. Creating a task shares only the reviewed fields you submit.
- Sync runs on opening the selected provider and every five minutes while visible, online, connected and settings are closed. Large imports continue in bounded requests. Sync now is also available. Only the selected provider polls; switching stops the previous view’s timers.
- Disconnect removes the token while retaining saved tickets and local links. Changing GitLab account or instance resets project selection and keeps its old cache separate. Only one GitLab instance is actively connected per user at a time.
- External Git operations are read only. Replies, editing and closing issues remain available through Open in GitHub/GitLab.

## Install on an existing deployment

Choose the patch matching your installed version:

| Installed version | Patch |
| --- | --- |
| 0.6.75 | `ba-client-ops-patch-v0.6.76-git-providers.zip` |
| 0.6.74 | `ba-client-ops-patch-v0.6.76-from-v0.6.74-git-providers.zip` |

1. Back up your project and database, then apply the matching patch from your project folder:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.76-git-providers.zip"
```

For v0.6.74, substitute its matching patch filename. Do not force a patch onto another version.

2. Before starting the updated server, open Supabase SQL Editor and run the entire accompanying **`schema-v19-v20-work-hub-git-providers.sql`**. The same file is included at `database/upgrades/schema-v19-v20-work-hub-git-providers.sql`. It adds private GitHub and GitLab tables in one transaction, keeping already-created GitHub tables and data. This works on an existing v0.6.74 or v0.6.75 database. If schema-v19 is already applied, you may instead run only `database/migrations/schema-v20-work-hub-gitlab.sql`.
3. Build and check:

```powershell
npm run build
npm run typecheck:server
```

4. Restart/redeploy and refresh the browser. Confirm version 0.6.76.

No new dependencies or environment variables are needed. Keep the existing **TENANT_INTEGRATION_MASTER_KEY** unchanged. If it is missing, the server administrator must configure encrypted integration storage before users can connect. Never replace an existing key used to decrypt other integrations.

For a new installation, extract the full build, follow README/.env.example, install with `npm ci`, and run `database/setup.sql` on a new empty Supabase database. Fresh setup now contains 20 migrations / 34 tables. Do not use fresh setup on an existing database.

## Connect a personal GitLab account

1. Sign in to your company’s GitLab website, or GitLab.com.
2. Open your avatar → Edit profile → Access → Personal access tokens. Older GitLab versions may show Access tokens directly.
3. Create a personal token named BA Work Hub, choose an expiry and select **read_api**. If a Generate token dropdown is shown, choose **Legacy token** for the read_api scope. Use a token belonging to the actual person whose created/assigned issues should be imported.
4. In the tracker, open Work Hub → GitHub / GitLab and choose **GitLab** in Ticket provider.
5. Open **My GitLab settings**. Enter the GitLab website URL, paste your token and click Connect GitLab. The username is detected from the token.
6. Load/select projects, optionally map client/project, then click **Save my projects** and Sync now.

The token can access only projects your GitLab account is permitted to read. If your organization disables tokens or requires additional authorization, ask its administrator. A read_repository-only token is insufficient for the issue API. The server must be able to reach the GitLab HTTPS website with a trusted certificate. This release accepts public DNS addresses; VPN-only, private-network, localhost or self-signed instances need a separately configured network deployment and are not supported by this connector.

GitLab API responses were simulated during validation. No company URL or live token was supplied, so verify a known issue after deployment.

## GitHub access

Choose GitHub in Ticket provider and use My GitHub settings. Existing v0.6.75 connections keep working. New connections use a personal fine-grained token with selected repositories and Issues: Read-only permission. Company approval/SSO may be required.

## Validation

- Production build and server TypeScript check passed.
- 93 functional tests passed, including 13 GitHub and 16 GitLab tests, plus document/AI/workspace route assertions.
- Existing Gmail/Discord suite: 6 tests passed.
- GitLab checks cover personal encryption, tenant/user/account/instance isolation, nested project paths, project discovery pagination, issue IID mapping, created/assigned union, old open and recent closed issues, resumed sync, closure/reassignment, QA/task-link preservation, task commit recovery, duplicate task prevention, comments, rate limits, revoked tokens, provider selection and error handling.
- Database setup consistency passed: 20 migrations / 34 tables. Migration was not executed against live Supabase.
- Both ZIP patches were applied to isolated matching baseline copies, with payload verification, production builds and server type checks. ZIP integrity passed.
- Live external APIs and interactive browser flows remain unverified. UI markup was checked in automated rendering.

## Deployment checks

- Connect User A’s GitLab account and import a known created/assigned issue. User B, including an administrator, must see only their own personal imports.
- Use your actual company instance URL and a nested project path, if applicable.
- Set Needs retest, link a subtask and resync; local fields should survive issue closure.
- Switch providers: each must show only its own connection and tickets. Existing GitHub settings should still be present.
- Create a task using a reviewed description; it should contain no token or private comments.
- Verify Email, Discord, Manual Logs and FSD custom features still work.

GitLab references: https://docs.gitlab.com/api/issues/ ; https://docs.gitlab.com/api/projects/ ; https://docs.gitlab.com/api/notes/ ; https://docs.gitlab.com/user/profile/personal_access_tokens/ ; https://docs.gitlab.com/security/tokens/access_token_scopes/
