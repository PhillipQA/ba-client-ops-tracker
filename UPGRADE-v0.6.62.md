# BA Client Ops Tracker v0.6.62 — automatic Gmail checks

This patch upgrades v0.6.61. Communications Hub now checks Gmail labels and selected messages when opened, after you save label settings, and every five minutes while the Hub is open and the browser is online. It also checks when the tab becomes visible or the connection returns. The Hub shows the last check or an error. Existing manual controls remain available.

Automatic checks reuse downloaded messages and import newly found messages. A manual **Check Gmail now** still refreshes existing messages. Large backlogs continue from saved progress on subsequent checks.

## Upgrade

1. Confirm your project is at `0.6.61` with `npm run patch:status` or `package.json`.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.62-auto-gmail.zip"`.
3. Run `npm run build`, restart the server, and deploy the updated source if using Render. Refresh the browser.
4. Under Communications Hub, select Gmail labels once and click **Save my settings**. Messages then import automatically while the Hub is open.

No database migration or npm install is needed. Automatic checks require a connected Gmail user, selected labels, and a working Google connection. This release does not run a server background job while the Hub is closed.
