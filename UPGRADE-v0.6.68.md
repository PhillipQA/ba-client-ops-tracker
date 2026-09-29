# BA Client Ops Tracker v0.6.68 — signed PDF filename

This patch upgrades v0.6.67. Completed DocHub documents now download through the tracker using the document name that was prepared for signing instead of the numeric/provider-generated name from DocHub storage.

Examples:

- `DRF-CARD-INDOGROSIR-INC.xlsx` → `DRF-CARD-INDOGROSIR-INC.pdf`
- `SO-Client-Branch.docx` → `SO-Client-Branch.pdf`

The signed PDF route retrieves the trusted DocHub/S3 PDF on the server, returns it as `application/pdf`, and supplies the tracker filename through `Content-Disposition`. Existing completed records are supported: the saved original filename is preferred and the saved document title is used as a fallback. No document needs to be re-sent for signature.

## Upgrade

1. Confirm `package.json` shows v0.6.67.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.68-signed-pdf-filename.zip"` from the project directory.
3. Run `npm run build`, restart the app, redeploy the updated source, and refresh the browser.
4. Open a completed DocHub item and click **View signed PDF**. The downloaded PDF should use the document name with a `.pdf` extension.

No database migration or dependency install is required. `database/setup.sql` was regenerated only to keep the fresh-install bundle metadata aligned with v0.6.68; do not run it on an existing database.
