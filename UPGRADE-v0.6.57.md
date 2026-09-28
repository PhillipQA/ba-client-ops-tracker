# Upgrade to BA Client Ops Tracker v0.6.57

This release adds automatic AI source review to FSD Creation. It builds on v0.6.56 and keeps its functional and data-integrity fixes.

## Installation

The patch expects **v0.6.56**. Back up your project and stop its running server, then run from your project folder:

```powershell
cd E:\Playwright\ba-client-ops-tracker
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.57-fsd-source-review.zip"
npm run build
npm run typecheck:server
npm start
```

Replace the ZIP path with your actual download location. No new dependencies or database migration are needed when upgrading an already working v0.6.56 installation. For the full build, extract into a clean folder, copy your existing local environment configuration, and run `npm ci`, `npm run build`, then `npm start`.

If you are upgrading from v0.6.55 or earlier, use the full build and complete the database prerequisites in `UPGRADE-v0.6.56.md`, including schema v16. Do not run the fresh-install database bundle over an existing database. This release adds no schema v17.

For Render, commit the updated source, keep your existing environment variables, deploy with `npm ci && npm run build`, and start with `npm start`. After deployment, reload open browser tabs and confirm **v0.6.57**. Do not commit your environment file, dependency folder or release ZIPs.

## New workflow

1. Upload a BRD or supporting document, or add pasted notes. Document details and the writing preset can be completed later.
2. Local extraction/OCR reads the text. Your account's **Document Agent** then reviews that source automatically for the currently checked scope.
3. Open the source card. It shows **Readable**, **Needs review**, **Unreadable**, or **Incomplete review**; what the AI understood; original supporting excerpts; and clarification questions.
4. Correct the extracted text where needed and select **Analyze source**. Failed AI calls retain the text and have their own retry button.
5. Add more supporting sources and choose/customize your preset. Unchanged source reviews are reused. The preset affects the combined FSD, not the original source facts.
6. Generate the preview. It combines all current source facts, preset instructions, guidance and selected modules. Conflicts are flagged for clarification instead of automatically preferring the newest document.
7. Review the preview and its questions before generating Word.

## Changes and reset behavior

- Editing source text, its type or mapping clears that source's review. Changing checked modules clears all source reviews. Use **Analyze pending sources**, or generation will review them first.
- Changing a preset or guidance invalidates the preview but keeps source reviews, because the underlying evidence has not changed.
- Removing a source removes it from later generation. Reset clears all source text, analyses and preview; late responses cannot restore them. Saved custom presets remain available.
- Sources mapped to unchecked modules are excluded from both AI review and generation. Shared sources are reviewed for the selected scope only.
- A source marked unreadable or incompletely reviewed must be corrected, replaced, split or removed before it can be included in generation. Partial readings retain their questions in the preview.

## Practical limits

- Uses the existing tenant Document Agent provider, model and API key. An automatic review makes an API request for each added source with readable text. Manual reanalysis also uses the API; changing a preset alone does not re-read the same sources.
- Reading is based on extracted text and English OCR. Visual diagrams, layout and non-English image text still require human review; this release does not add multimodal image interpretation. Readability is an AI assessment, not a guarantee of correct interpretation.
- Original extracted text remains available and supporting quotes are checked against it. The summary itself is an interpretation for you to review, not additional evidence.
- Existing limits remain: 10 MB per file, 80 PDF pages, 120,000 extracted characters per source, 20 sources and 180,000 total source characters. Combined generation allows at most 120 supported facts/requirements and 100 source questions. Larger work must be split; the application rejects excess combined results rather than silently discarding them.
- Source text and reviews stay in the current browser-tab draft. They are not a shared document library or permanent AI memory. Existing provider retention policies still apply to API requests.
- A PDF reader download failure occurs before AI review. The message now gives refresh/reselection instructions, and the upload retry opens the file picker instead of mistakenly starting FSD generation. A missing deployment asset still needs the deployment to be corrected.

## Verification

Build and server type checks passed. The functional suite passed, including new source-review route checks with controlled AI responses. Browser checks covered automatic review, later supporting sources, preset and scope changes, source editing/removal, failed-call retry, pasted notes, and Reset during an active review. Patch installation and rollback were checked against the v0.6.56 full build.

Live calls with your Document Agent credentials, hosted Render/Supabase checks and security testing were not performed. See `docs/releases/verification-v0.6.57.md` for the exact verification scope.

## Rollback

Stop the server and run:

```powershell
npm run patch:rollback
npm run build
npm start
```

Rollback restores the previous application source. No database rollback is needed for this release. Reload open browser tabs after restarting.
