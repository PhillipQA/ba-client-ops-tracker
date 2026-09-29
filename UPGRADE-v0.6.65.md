# BA Client Ops Tracker v0.6.65 — document filename hotfix

This patch upgrades v0.6.64. Document Creation now shows an editable filename in each of DRF, FSD, BRD, and Sign Off. The suggested name follows the entered client, project, or branch/site until you change it manually.

| Document | Suggested filename stem |
| --- | --- |
| DRF | `DRF-{client name}-{branch/site}` |
| FSD | `FSD-{client name}-{project name}` |
| BRD | `BRD-{project name}` |
| Sign Off | `SO-{client name}-{branch/site}` |

The app appends the actual template extension automatically. For Sign Off with non-image supporting files, the downloaded package is a ZIP and the Word form inside it has the same stem. That Word form is also the file prepared in DocHub. DRF's generated file and DocHub draft use the same filename. FSD and BRD export Word files; this build does not yet offer DocHub preparation for those two creators. The document reference printed inside the form is independent from its filename.

You can edit the filename before generation. Invalid filesystem characters become hyphens. Clear the filename and leave the field to restore the suggested value. Repeated documents for the same client and site/project can be distinguished by editing the filename.

## Upgrade

1. Confirm `package.json` is v0.6.64.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.65-document-filenames.zip"` from the project directory.
3. Run `npm run build`, restart the app, deploy the updated source to Render, and refresh the browser.
4. Generate one DRF and one Sign Off with custom names and verify the downloaded filename and the title in DocHub History.

No database migration or dependency install is required.
