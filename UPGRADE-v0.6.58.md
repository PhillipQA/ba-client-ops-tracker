# Upgrade to BA Client Ops Tracker v0.6.58

This release clarifies FSD upload and preview: files are reviewed by AI when added, while the preview button lists any missing document details before it becomes available. It also displays the running app version on the FSD screen.

## Upgrade from v0.6.57

The patch requires **v0.6.57**. Back up the project and stop the running server. From your Windows project folder:

```powershell
cd E:\Playwright\ba-client-ops-tracker
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.58-fsd-preview-guidance.zip"
npm run build
npm run typecheck:server
npm start
```

Replace the ZIP path with your download location. On Render, commit the updated source and deploy with the existing build (`npm ci && npm run build`) and start (`npm start`) commands. Reload any open browser tabs after deployment; the FSD screen should show **App v0.6.58**.

No new dependency or database migration is needed when upgrading from a working v0.6.57 installation. To use the full build instead, extract it into a clean folder, copy your existing environment configuration, then run `npm ci`, `npm run build` and `npm start`.

If your project is still on **v0.6.56**, apply the [v0.6.57 patch](docs/releases/v0.6.57.md) first or use the v0.6.58 full build. Upgrades from v0.6.55 or earlier must also complete the schema v16 prerequisite in [UPGRADE-v0.6.56.md](UPGRADE-v0.6.56.md). Never run the fresh-install database bundle over an existing database.

## What changes on the FSD screen

1. Upload files or add pasted notes. AI source review starts as soon as each source is readable and retains the extracted text.
2. The upload/review result appears separately from preview prerequisites. An OCR warning still asks you to verify images and diagrams in the original.
3. Before generating a preview, the panel lists missing Client, Feature name, Product, Prepared by, Document date, or Revision fields. If pasted text was not added as a source, it asks you to add or clear it. The preview button becomes available when these conditions and an included source are present.
4. After filling details, choose the current preset and click **Generate AI preview**. Source reviews from v0.6.57 continue to be reused when unchanged.

An invalid date is reported beside the button. Uploading without document details no longer results in a misleading “FSD processing failed” message when preview is attempted. The FSD status line displays the version actually loaded in the browser, which helps detect an old tab after deployment.

The earlier `Failed to fetch dynamically imported module .../assets/pdf-*.js` error is a PDF asset download failure. If it appears, refresh the deployed page and reselect the PDF. The browser must load the deployment's current built assets before extraction and AI review can run.

## Verification and rollback

Production build, server type check, and browser checks for upload before document details, exact missing-field guidance, and successful preview after completing them passed. These checks used controlled AI responses. Live account AI, hosted deployment and security testing were not performed. Details: [verification-v0.6.58.md](docs/releases/verification-v0.6.58.md).

The patch ZIP was checked against the v0.6.57 full build and its rollback restored that baseline. To roll back, stop the server, run `npm run patch:rollback`, run `npm run build`, restart and refresh the browser. No database rollback is needed.
