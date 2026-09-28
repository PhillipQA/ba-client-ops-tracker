# Upgrade to BA Client Ops Tracker v0.6.59

This release improves FSD source reading for PDFs that combine selectable text and embedded report screenshots. The PDF reader OCRs each screenshot at its own resolution, keeps the selectable transaction rows, and labels image text so figures can be checked against the original. FSD AI review treats dashboard example values as samples unless the source explicitly defines a rule.

## Upgrade from v0.6.58

The patch requires **v0.6.58**. Back up the project and stop the server. From the project folder:

```powershell
cd E:\Playwright\ba-client-ops-tracker
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.59-pdf-report-ocr.zip"
npm run build
npm run typecheck:server
npm start
```

Replace the ZIP path with your download location. For Render, commit the updated source and deploy with the existing build and start commands. Refresh open tabs; the FSD screen should show **App v0.6.59**. No new dependency or migration is needed from a working v0.6.58 install. The full build is also available for a clean installation with the existing environment configuration.

Earlier versions should first apply the intervening patch or use the full build. Schema v16 remains required for projects upgrading from v0.6.55 or earlier; see [UPGRADE-v0.6.56.md](UPGRADE-v0.6.56.md). Do not run the fresh-install database bundle over an existing database.

## Using the inventory report PDF

1. In **FSD Document Creator**, select **MMS Report** in scope. Upload the PDF as a Supporting document.
2. Open its source review and compare the extracted text with the original screenshots. The reader now captures inventory by size/location, withdrawals, unposted transactions, aging, and BO/disposals headings and columns. Correct uncertain OCR values or leave them as gaps.
3. Add the transaction and calculation rules as another source if available. This PDF shows examples but does not fully specify every formula, posting rule, date filter or data source.
4. Choose your preset, fill the listed FSD details, generate the AI preview, check cited requirements and gaps, then generate the Word document.

The app still creates an **FSD specification**, not a populated live inventory report. Local OCR and the backend Document Agent are separate stages; a readable upload does not confirm that the live AI provider is configured or that its interpretation is correct.

## Verification and rollback

The production build, server type check, FSD scope tests, and browser extraction against the supplied two-page PDF passed. Extraction recovered report headings absent from the previous full-page OCR while preserving selectable transactions. No live AI provider, hosted deployment, or security test was run. See [verification-v0.6.59.md](docs/releases/verification-v0.6.59.md).

The patch was applied to the v0.6.58 full build and compared byte for byte with the v0.6.59 full build; rollback restored v0.6.58. To roll back, stop the server, run `npm run patch:rollback`, rebuild, restart and refresh. No database rollback is needed.
