# BA Client Ops Tracker v0.6.72 — DocHub native signer reminders

This patch upgrades v0.6.71. It corrects the Signatories and activity **Send notification** action so reminders are sent by DocHub itself instead of by the tracker SMTP sender.

## What changed

- The tracker refreshes the sign request before attempting a reminder.
- For an unsigned signer, the backend calls `POST /api/v2/sign-requests/{signRequestId}/resend-email` with `{ "signerId": "..." }` using the tenant's existing DocHub API credential.
- DocHub sends the signing invitation/reminder email, preserving DocHub's secure signer link and delivery workflow.
- SMTP settings are no longer checked or used by the DocHub reminder button. SMTP remains available for password recovery only.
- Signed (`FINALIZED`) and rejected signers cannot be reminded. The button remains disabled for signed signers in the UI.
- Successful native resends store the last reminder timestamp/sender and mirror an activity entry into the linked task/subtask.
- The per-signer local cooldown is now 3 minutes to match DocHub's documented resend limit. DocHub may also apply bounded hourly limits.
- For sequential signing, DocHub may reject a later signer until it is that signer's turn; the tracker reports that condition without recording a reminder as sent.

## Upgrade

1. Confirm `package.json` shows v0.6.71.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.72-dochub-native-reminder.zip"`.
3. Run `npm run build`, restart/redeploy, and refresh the browser.
4. Open an IN_PROGRESS DocHub document. Click **Send notification** for a pending signer and confirm DocHub resends the invitation.
5. Confirm the activity entry appears and that a signed signer's button is disabled.

No database migration, dependency install, or SMTP change is required. Existing SMTP configuration is still used by password recovery.
