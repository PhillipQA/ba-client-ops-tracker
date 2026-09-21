# BA Client Ops Tracker v0.6.12 — FSD Creator

This release upgrades v0.6.11. It adds a working FSD Creator based on your supplied **FSD Template 052026 - NEW.pdf**.

## Install the patch

Stop the app. Save the patch ZIP in `E:\Playwright`, then run these commands from your existing `E:\Playwright\ba-client-ops-tracker` folder:

```bat
npm run patch:status
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.12-fsd-creator.zip"
npm run build
npm run dev
```

The starting version must be **0.6.11**. The updater creates its normal rollback backup. No new dependency or Supabase migration is required. Existing environment files, account data, encrypted credentials and Discord settings are preserved. Keep your integration encryption master key unchanged.

For Render, commit and push the updated project through your usual deployment process; Render must build and restart the server. Refresh existing browser tabs after deployment. This package does not deploy your live site automatically.

For a new folder using the full build ZIP, restore your existing local environment settings, run `npm ci`, then `npm run build` and `npm run dev`. Use `npm start` for the production server after building.

## Use FSD Creator

Open **Document Creation → FSD Creation**.

1. Select **Basic Mode** or **Advance Mode**.
2. Enter client, feature, product, author, date and revision. Add the signatory names if available. The reference can be entered manually or generated as `FSD-CLIENT-YEAR-MMDD-01`.
3. Upload a BRD and other requirements, or paste meeting notes/chat and choose **Add to sources**. A BRD is recommended; other explicit requirements can also serve as sources.
4. Review extracted source text. Choose a preset from the dropdown, edit its instructions, or save a custom preset.
5. In Advance Mode, select applicable modules, map each source primarily to a template section, and add section-specific instructions.
6. Select **Generate AI preview**. This sends source text, metadata and your selected instructions to the account’s configured AI.
7. Review the generated sections, tables, missing information and source conflicts. **Edit preview** allows editing paragraphs and table cells.
8. Confirm that you reviewed the preview, then select **Generate & Download FSD (.docx)**. Export uses the reviewed content; it does not make a second AI call. In Word, update the table of contents for final page numbers.

Changing source content, metadata, mode or generation instructions marks the old preview as outdated. Regenerate it before exporting. Unknown details remain marked TBD, and pending review items are included in the exported document. Client approval and signatures are never filled automatically.

## Two modes

| Basic Mode | Advance Mode |
| --- | --- |
| Multiple document uploads and optional pasted requirements | All Basic Mode source formats |
| Common preset dropdown and editable instructions | Source-to-section mapping |
| AI determines module applicability from evidence | Explicit MMS, MMS Report, Lynexus and POS scope |
| Editable preview and Word export | Additional skills and per-section guidance |

Both modes follow the same FSD section structure. Switching modes retains your entries. Advance Mode controls are retained but are applied only when Advance Mode is selected.

## Account AI settings

FSD Creator, BA Assistant and Discord inquiry assessment use the same enabled account integration. FSD uses the **documents** module permission; contributors can generate, viewers cannot.

Supported providers: **Gemini**, **OpenAI (ChatGPT models)**, **Claude (Anthropic)** and **DeepSeek**. Configure the provider, its API key and a model available to your account in **Settings → AI Integration**. Existing provider and model selections remain unchanged; Gemini continues to default to `gemini-3.8-flash` for new configurations. Switching providers requires a new provider key. Credentials are read server-side and are never stored in the FSD draft.

Provider API references used during implementation: [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [Claude Messages](https://platform.claude.com/docs/en/api/messages/create), [DeepSeek API](https://api-docs.deepseek.com/).

## Draft retention

- Navigating to another module keeps Document Creation mounted, so source extraction and generation can finish while you navigate.
- Draft inputs, extracted text, mode, custom instructions and preview are also saved to browser session storage, scoped to the signed-in account and user.
- Refreshing the same tab restores the saved draft. Closing the tab, clearing browser data or a browser storage failure may remove that draft. This release does not sync FSD drafts to Supabase or other devices.
- Original file bytes are not retained; the extracted, editable source text and filename are retained.
- Custom presets are saved in local browser storage for that account/user, survive new FSD drafts, and can be reused in later browser sessions.
- **Start new FSD** asks before clearing the draft and keeps saved custom presets.
- If browser storage is unavailable, a visible warning explains that refresh recovery is unavailable; the mounted workspace still retains its current values.

## Source and output limits

PDF, DOCX, TXT, MD, CSV and JSON: up to 10 MB each, 20 sources, 120,000 extracted characters per source and 180,000 characters in total. PDFs are limited to 80 pages. Limits return errors; content is not silently truncated.

Scanned PDF pages use local English OCR. OCR may need to download language assets. PDF diagrams, embedded images, audio and video are not interpreted. Add their relevant requirements as text. Convert older DOC files to DOCX first.

The supplied PDF is a reference, not a fillable template. The generator reproduces its structure in editable Word with the iRipple logo/header, approval cover, exact proprietary notice, contents field, document history, process tables, acceptance criteria, technical specifications and references. Pagination expands to fit the requirements; it is not fixed at 12 pages. Arbitrary replacement template upload is not included in this release.

## Validation performed

- Frontend production compilation and server TypeScript check passed.
- A local sample Word export was rendered and visually inspected for template layout and table wrapping.
- Full automated regression suites and live AI-provider requests were not run. Validate with your saved provider/model before using a generated FSD for approval.
