# v0.6.33 — DocHub eSignature Integration

This release adds tenant-admin DocHub API settings, unsent signing preparation for DRF and Sign-Off documents, task/subtask comments, signer progress, and signature-completion notifications. It upgrades **v0.6.32** and preserves its document-processing indicators and Client view options.

## Upgrade an existing v0.6.32 installation

1. Stop the app and retain your normal application/database backup.
2. In `E:\Playwright\ba-client-ops-tracker`, apply the patch:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.33-dochub-integration.zip"
```

3. In **Supabase → SQL Editor**, run the complete contents of **`supabase/schema-v10-dochub.sql`**. The patch copies this file but does not execute SQL. This adds two private, tenant-scoped tables; existing tracker records are retained. Existing installations should already have migrations through v9.
4. Build and restart:

```powershell
npm run build
npm run dev
```

For Render, commit/deploy the updated source through your existing deployment process and use your existing production start command. Refresh open browser tabs. `npm run patch:status` should report **0.6.33**.

No new npm dependency is added. A fresh installation from the full build still requires `npm ci`, the existing Supabase setup/migrations in order through v10, and your existing environment configuration.

## Connect each tenant/account

Sign in to the intended account (for example, BXI-Core) as an **Administrator with Settings access**:

1. Open **Settings → DocHub integration**.
2. Create a key at <https://dev.dochub.com/settings/api-keys>. Allow the operations used below: document upload/import/read, recipient-role creation/read, formfield read, sign-request creation/read, and PDF download. Webhook creation permission is needed only for the optional registration button.
3. Paste the key, enable the connection, and choose **Save DocHub settings**. Saving verifies document read access. **Test connection** repeats that check; upload and signing permissions are checked when those operations run.

Every account stores its own encrypted key. Contributors and Viewers cannot read or change keys. Browser requests cannot select another tenant. Disabling an account's connection pauses preparation and synchronization for that account.

The existing **`TENANT_INTEGRATION_MASTER_KEY`** remains the server encryption key used by tenant integrations. Keep its current value; changing it without re-encrypting stored credentials prevents decryption. This release does **not** require a global DocHub API key in Render. It uses DocHub's documented **X-API-Token** authentication; OAuth is not part of this release because account-admin API key entry was requested.

## Generate and prepare a document

- Open DRF Creation or Sign Off Form. Add **Email (DocHub only)** beside every used signatory. Emails are workflow metadata and are not printed into the generated document. Leave unused signatory names/emails blank.
- When DocHub is enabled, **Prepare an unsent DocHub draft after generation** is selected. Turn it off when you only want the usual download.
- Select the client and an existing **Task or Subtask**, optionally filtering by project. One document links to one work item. No extra task or Action Center document queue is created.
- Choose simultaneous or sequential signing. Sequential order follows the form's signatories (Sign-Off: iRipple signatories, then client signatories).
- Click **Generate & Prepare in DocHub**. The original Excel/Word file still downloads. The app uploads it privately and DocHub converts it to PDF.
- For a Sign-Off package containing extra files, only the generated Word form, including its embedded images, is sent for signing. Other attachments remain in your downloaded ZIP and are not automatically merged into the signing document.
- Open the prepared document in DocHub. Check the converted layout, place Signature/Date/Initial fields, assign them to the correct recipients, review, and send **from DocHub**.

The app always requests `preparingEnabled: true` and never calls a send, resend, or bulk-send endpoint. It does not automatically grant signers free annotation/editing access. If DocHub rejects draft creation because signature fields do not exist yet, it retains the uploaded document and prepared email roles as **Unsent · setup required**. Finish field placement and sending in DocHub. The tracker discovers the resulting sign request during synchronization.

**Unsent · ready for review** means the API reports a required signature field for each prepared recipient. It is an aid to review, not a guarantee that all DocHub send requirements are satisfied.

## Task/subtask workflow and completion

- From a Task/Subtask editor, use **Create DRF for this work** or **Create Sign-Off for this work** to preselect that work item in Document Creation.
- **Linked documents** shows the DocHub status and signer progress. System entries in **Activity comments** record preparation, views/signatures exposed by the API, status changes, and completion.
- Action Center and task rows show DocHub badges on the existing work item. The existing follow-up reminder mechanism is reused.
- Optional follow-up days set the linked task's follow-up date after the app first observes sending, only if the work item has no follow-up date. Existing follow-up dates are retained. Dates use Asia/Manila, matching the intended workspace; timestamps display in the browser's local time.
- When DocHub reports **FINALIZED**, the app marks the document **Signature complete**, adds a system comment, and notifies the creator, current assignee, and active account Administrators. Repeat syncs do not repeat the alert.
- The task is **not automatically closed**. **Set completed status** in its linked-document section changes the editor selection; review and **Save changes** to confirm.
- **View signed PDF** obtains a fresh authorized download link from DocHub. Signed PDFs remain in DocHub; this release does not maintain a separate permanent PDF archive in Supabase.
- Document Creation keeps a document history (latest 500 records). Deleting a linked task does not delete the DocHub document/history.

## Live updates and background checks

The running app server checks pending documents about once a minute. A sleeping/stopped Render service cannot poll; it catches up after waking. The in-app notification bell refreshes every minute and on focus. **Refresh status** checks a document on demand; opening/focusing the app also reloads task comments.

For prompt completion updates, configure webhooks:

1. Set the existing server **`APP_BASE_URL`** to the tracker’s public HTTPS origin, for example `https://your-tracker.onrender.com`.
2. Open the account's **Settings → DocHub integration → Live completion notifications**.
3. Choose **Register DocHub webhook** after saving/enabling the API key.

Webhook creation depends on DocHub plan/API permissions. If registration is unavailable, background checks remain usable.

Alternatively, create the webhook in DocHub's developer portal using the account-specific callback URL shown in Settings, subscribe to `document.status_changed`, `sign_request.created`, `sign_request.voided`, `signer.finalized`, and `signer.rejected`, and save its signing secret in Settings.

Webhook verification uses HMAC-SHA256 over the exact raw body and timestamp, a five-minute freshness window, and a separate encrypted secret per account. A valid event only triggers a fresh API read for a document already linked to that tenant. Intermediate viewed/progress changes may be discovered by polling rather than webhook delivery.

## Recovery and operational limits

A preparation has a persistent ID. Retrying or refreshing resumes it instead of uploading another document. A deliberate new generation creates a new revision/document.

If the import response is lost before the import ID is received, automatic re-upload pauses at **Import needs review**. Check DocHub for the matching uploaded file, then enter its document ID in that preparation to resume it. If no file exists, generate a new preparation. For a provider-reported conversion failure, correct the source file and generate again. Do not use the recovery field to attach an unrelated document.

Supported signing inputs are PDF, DOCX, and XLSX up to 15 MB. History and synchronization cover the latest 500 tracker documents per account. The app retains its existing **single-server-instance** session/concurrency architecture; this release does not add distributed workers. Records are private under Supabase RLS and accessible through the authenticated server using its service role.

API keys, webhook secrets, and document bytes are not included in normal workspace snapshots or browser caches. Generated bytes are held privately for preparation until import is accepted. An interrupted upload can retain its pending file until the preparation is resumed.

## Verification

- Production frontend build and strict server TypeScript check passed.
- **11 DocHub checks** passed using the official API response shapes and a simulated provider: tenant isolation, role restrictions, encryption, raw webhook verification, unsent preparation, import recovery, duplicate suppression, field readiness, completion notifications, and keeping tasks open.
- **30 affected regression checks** passed for integrations, lifecycle/archive protection, notifications, and Sign-Off generation.
- The v0.6.32 patch installation and payload integrity were checked locally.
- No live DocHub account/API key was available. Live conversion quality, API entitlement/permissions, real webhook delivery, and signed-PDF retrieval still require a tenant test after setup. No signer emails were sent during verification.
- Browser visual testing was unavailable because this environment has no browser executable. Existing form layouts and styles are reused.

## Official API references used

- Authentication: <https://dev.dochub.com/docs/authentication/api-key>
- Current endpoint/schema contract: <https://dev.dochub.com/api-reference/openapi.yaml>
- Webhook verification: <https://dev.dochub.com/docs/webhooks/receiving>
- Event catalog: <https://dev.dochub.com/docs/webhooks/events>

Contract retrieved September 24, 2026. Upload uses `/api/v2/s3-direct` then `/api/v2/documents/imports`; recipients use `/api/v2/document-roles`; unsent drafts use `/api/v2/sign-requests`; status, fields and completed PDFs are read through their documented endpoints.

## Rollback

`npm run patch:rollback` restores the previous code. The additive v10 tables may remain, preserving DocHub history/settings for a later re-upgrade. A code rollback does not remove remote DocHub documents or cancel requests you sent there. Disable the webhook in DocHub if the rolled-back server no longer exposes its callback.
