# BA Client Ops Tracker v0.6.66 — DRF computer name length

This hotfix upgrades v0.6.65. In Document Creation → DRF → POS / Computer Rows, the Computer Name input now accepts up to 16 characters. The Excel generator also keeps up to 16 characters in the Computer Name column; values exceeding 16 characters sent directly to the API are shortened to 16.

## Upgrade

1. Confirm `package.json` shows v0.6.65.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.66-drf-computer-name.zip"` from the project directory.
3. Run `npm run build`, restart the app, redeploy the updated source, and refresh the browser.
4. Enter a 16-character Computer Name, generate a DRF, and confirm the complete name appears in the Excel output. Check that a 17th character cannot be entered.

No database migration or dependency change is required.
