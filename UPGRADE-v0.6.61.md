# BA Client Ops Tracker v0.6.61 — FSD Word source reading

This patch upgrades v0.6.60. It fixes a document-upload issue where Word header logos and footer decoration could start OCR even though all requirements were already readable as Word text. The FSD, BRD, and Test Case creators share this source reader.

## Upgrade

1. In your project folder, confirm `package.json` is version `0.6.60`.
2. Apply `ba-client-ops-patch-v0.6.61-fsd-docx-reading.zip` with `npm run patch -- "path-to-zip"`.
3. Run `npm run build`, restart the application, and refresh the browser.

No dependency, database migration, or settings change is needed. The patch updater can roll back this patch if needed.

## Verify

Upload `BRD-METABASE-20260928-01.docx` in FSD Creation. Its requirements and mapping tables should appear in the extracted text. The header logo and footer wave should not trigger OCR. Check the AI source review separately; an AI provider or quota error will still appear as an analysis error with the extracted text retained.
