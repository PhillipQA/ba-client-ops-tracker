# BA Client Ops Tracker — v0.6.13 Upgrade

## Included changes

### Action Center pagination
- **My Action Center** now shows **10 items per page by default**.
- Users can change the page size to **10, 25, or 50** items.
- Previous/Next controls and the current item range are shown below the table.

### Inline AI BA Assistant assessment
- **Assess with AI** on Action Center no longer redirects to the AI BA Assistant module.
- The assessment is returned directly below the Action Center AI prompt in a compact read-only result box.
- Results below 200 words are shown in full.
- Results of **200 words or more** show a 200-word preview and a **View in AI BA Assistant** button.
- The complete prompt, response, and AI suggestions are preserved in the matching AI BA Assistant conversation so the full result is available when opened.

### FSD Creator theme merge
- Includes the v0.6.12 adaptive-theme patch.
- FSD Creator UI follows the browser/system light or dark color scheme.
- The generated-document preview remains white to represent the exported document accurately.

## Upgrade

From v0.6.12:

```bat
npm run patch -- "C:\path\to\ba-client-ops-patch-v0.6.13-action-center-ai.zip"
```

No dependency or database migration is required. Restart the app after applying the patch.

## Validation checklist

1. Open **Action Center > My Action Center** and confirm the default page size is 10.
2. Change page size to 25 and 50, then return to 10.
3. Confirm Previous/Next buttons change pages and disable at the first/last page.
4. In **Action Center > AI BA Assistant**, enter a prompt and click **Assess with AI**.
5. Confirm the result appears below the prompt without leaving Action Center.
6. For a response of 200+ words, confirm only the first 200 words are previewed and **View in AI BA Assistant** opens the full conversation.
7. Switch browser/system color scheme and confirm the FSD Creator follows it while the document preview stays white.
