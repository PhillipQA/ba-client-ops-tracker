# BA Client Ops Tracker v0.6.55

## Document resets and Advanced-only FSD

- FSD Creation now opens directly in Advanced Mode. Basic Mode and its selector have been removed. Existing saved Basic Mode inputs are retained in Advanced Mode; their preview must be regenerated under the selected scope.
- Every FSD source has a visible Remove button on its collapsed row. Removing a source also clears the generated preview and review approval so its contents cannot be exported from an old preview.
- Reset controls are available at the top of DRF, FSD, Sign Off and Test Case Creation, including while document work is pending.
- Reset clears the current creator's user-entered fields, uploads, pasted text, extracted values, mapping instructions, preview/coverage/results and errors, then restores that form's initial defaults. Defaults such as the current date, built-in preset, product and standard signatory labels are regenerated; old user values are not retained.
- FSD and Test Case saved session drafts are cleared and replaced with fresh empty drafts, so switching modules or refreshing cannot restore discarded content. Saved custom presets/testing skills remain available, but previous custom selections and draft instructions are reset.
- DRF and Sign Off also clear signer emails, DocHub client/task/project choices, preparation results and retry payloads. DocHub preparation is switched off until selected again.
- Pending browser requests are aborted where supported. Late upload/OCR/AI/export callbacks cannot restore cleared data, download a discarded document or begin DocHub preparation after reset. Local OCR already underway may finish in the background; its result is discarded.
- DRF includes a Remove control for the COR; removal also clears the four COR-derived fields. The same file may be uploaded again after removal or reset.
- Templates managed in Settings, integration credentials, saved DocHub history and the other document creators' drafts are retained. Reset does not delete documents already prepared in DocHub or undo work already accepted by a remote service.

## Upgrade from v0.6.54

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.55-document-reset.zip"
npm run build
```

Restart the application/server after building. There is no new database migration, no dependency change and no `npm install` requirement. Existing databases remain on schema v15. Do not rerun the fresh-database setup script on an existing installation.

For a new installation, use the full-build ZIP and follow README.md.

## Validation

- Full TypeScript/Vite production build: passed.
- Server TypeScript check: passed.
- Existing FSD hard-scope regression checks: 4/4 passed.
- Existing DocHub regression checks: 13/13 passed.
- Browser reset checks: 19/19 passed, using the actual React components with simulated API responses and delayed file reads. External AI/DocHub services were not contacted.
- Database bundle: 15 migrations / 29 tables, unchanged schema.
- Patch updater: clean v0.6.54 to v0.6.55 application and file comparison passed.
