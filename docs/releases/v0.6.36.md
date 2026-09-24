# v0.6.36 — Authentication connection handling and diagnostics

Upgrade path: **v0.6.35 → v0.6.36**.

Reported sequence: **login succeeds → logout appears to succeed → the next login fails with `net::ERR_CONNECTION_CLOSED`**. The initial `/api/auth/session` response of `401` is expected when signed out and does not cause this connection error.

This is a candidate mitigation and diagnostic release. The exact production failure has not been reproduced locally, so this package does not establish that Render's connection timeout is the root cause.

## Changes

- Set Node's HTTP keep-alive timeout to 120 seconds and its header timeout to 130 seconds. Render recommends longer values for intermittent Node connection failures. Request timeouts, the login policy, and credentials remain unchanged.
- Show an error when logout fails instead of silently returning to the login screen. Disable repeated sign-out clicks while a request is pending. An already-expired session (`401`) can still leave the signed-in screen.
- Give interrupted authentication requests a reference number. Render logs record matching `[auth]` start/completion entries, status, version, and duration. Prematurely closed responses have a separate event.
- Do not record passwords, bodies, cookies, tokens, account/user names, or IP addresses in these new diagnostics. Credentials are not automatically retried.
- Preserve the server's credential/lockout messages. A valid `429` remains a lockout and is not relabeled as a connection failure.

No Supabase migration, new dependency, `npm install`, or Render environment-variable change is required.

## Apply and deploy

From the existing v0.6.35 project folder in Windows Command Prompt:

```bat
cd /d E:\Playwright\ba-client-ops-tracker
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.36-auth-connection.zip"
npm run patch:status
npm run build
```

Adjust the ZIP path if needed. Commit and push the patched files, including the new `auth-transport.ts`, using your normal Render deployment process.

After deployment, check the startup log for `ba-client-ops-tracker@0.6.36` and `HTTP timeouts: keepAlive=120000ms, headers=130000ms`. Refresh the browser and confirm the page shows v0.6.36.

Test once: **login → logout → login**, then try the same account in a second browser. This production check is still required.

## If the connection error persists

Copy the displayed reference number and find that exact value in Render's Logs:

| Log result | Interpretation |
| --- | --- |
| No matching `started` entry | The request may not have reached this instance, or the selected logs may be incomplete. Check all relevant instances and the exact time first. |
| `started`, then `completed` | Node finished writing a response. This does not guarantee the browser received it. Check the logged status and browser error. |
| `closed_before_response` | The response connection closed before Node finished it. This does not identify which component closed the connection. |
| `started` only | Inspect nearby application errors, restarts, and Render events. The request may still be running or the process may have stopped. |

Share only the reference number, these diagnostic lines, and the browser error. Passwords, cookies, full payloads, and private keys are not needed.

## Verification

- Eight targeted tests cover interrupted connections/response bodies, lockout messages, anonymous sessions, malformed proxy responses, logout failures, and credential-free correlated logging.
- v0.6.36 authentication handlers are exercised over local HTTP with an isolated mock database for login → logout → fresh login and independent sessions.
- Server type-checking, the production build, and patch application from v0.6.35 are checked.
- Local checks do not reproduce Render's edge proxy or the user's browser/network path. The live cause and outcome remain unverified.

Rollback if needed: `npm run patch:rollback`, then rebuild and deploy normally. This patch changes code only.

Reference: [Render troubleshooting guidance](https://render.com/docs/troubleshooting-deploys#502-bad-gateway).
