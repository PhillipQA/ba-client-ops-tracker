# BA Client Ops Tracker v0.6.70 — Signatory reminder notifications

This patch upgrades v0.6.69. **Document Details → Signatories and activity** now includes a **Send notification** action below every signatory.

- Pending/unsigned signatories can be reminded without leaving the tracker.
- Signed signatories keep the button visible but disabled/greyed out.
- Before a reminder is sent, the tracker refreshes the DocHub request so a signer who just completed the document is not notified from stale status.
- Successful reminders store the last notification timestamp and sender on the signer card and add a DocHub activity entry. Linked task/subtask activity comments receive the same system entry.
- A one-minute per-signer cooldown prevents accidental repeated sends.
- Reminder emails use the tracker's existing SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional SMTP credentials). No new dependency is required.

## Important provider behavior

DocHub exposes manual **Send Reminder** in its Manage/Audit interface, but this build does not call an undocumented/private DocHub endpoint. The tracker reminder is sent from the app's configured SMTP account and tells the signer to use the secure link from the original DocHub signature-request email. The app does not fabricate or expose a signer-specific URL.

## Upgrade

1. Confirm `package.json` shows v0.6.69.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.70-signatory-notifications.zip"` from the project directory.
3. Run `npm run build`, restart the app, redeploy the updated source, and refresh the browser.
4. Open an in-progress DocHub document. Under **Signatories and activity**, click **Send notification** for an unsigned signer. Confirm the email arrives and a reminder activity entry appears. Confirm a signed signer has a disabled button.

No database migration or dependency install is required. If SMTP is not configured, the tracker returns a clear configuration message and does not record a reminder as sent.
