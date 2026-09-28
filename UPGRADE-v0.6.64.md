# BA Client Ops Tracker v0.6.64 — separate DocHub recipient roles for each DRF

This patch upgrades v0.6.63. The same people can sign a second or later DRF. The DocHub integration now verifies that a recipient role belongs to the current document before reusing it. An email address alone never identifies a document role.

For an existing draft affected by this problem, open its card in DocHub History and click **Refresh status**. When DocHub exposes document IDs for its roles, the app can replace a role inherited from another document and retry preparing the unsent draft. If the old draft has already been sent, it will not change its recipients; review it in DocHub. The app prepares an unsent draft and does not send signature invitations automatically.

## Upgrade

1. Confirm `package.json` is v0.6.63. If you are on v0.6.62, apply the v0.6.63 DRF error log patch and its Supabase migration first.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.64-dochub-recipient-roles.zip"`.
3. Run `npm run build`, restart the app, deploy updated source to Render, and refresh your browser.
4. Generate two new DRFs with the same signatory emails and open each in DocHub. Their recipient roles should belong to different DocHub document IDs.

No new database migration or dependency install is required for v0.6.64.
