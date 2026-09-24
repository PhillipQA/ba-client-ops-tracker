# BA Client Ops Tracker v0.6.11 — Gemini per-account AI

This release upgrades **v0.6.10 → v0.6.11** and adds Gemini as the default AI provider for new tenant/account AI configurations. Existing OpenAI configurations remain compatible and are not converted automatically.

## What changes

- **Gemini via Google AI Studio** is available under **Settings → AI Integration**.
- New AI configurations default to **Gemini** with model `gemini-3.8-flash`.
- Each account/tenant keeps its own encrypted AI credential; the full key is never returned to the browser after saving.
- The same tenant AI provider powers the **BA Assistant** and optional **Discord inquiry assessment**.
- Existing OpenAI tenants continue using their existing OpenAI key/model. The patch infers legacy OpenAI configurations from their `gpt-*` model and does not silently reinterpret their credentials.
- Switching between Gemini and OpenAI requires entering a new provider key, preventing an old provider key from being reused accidentally.
- **No new Supabase migration** and **no new npm dependency** are required. The existing tenant integration record and encryption master key are reused.
- COR extraction remains local in the browser and does not send the COR file to Gemini/OpenAI.

## Apply the patch

1. Stop the app and confirm your current version:

```bat
npm run patch:status
```

It must report **0.6.10**.

2. Apply the patch:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.11-gemini-ai.zip"
```

3. Verify locally:

```bat
npm run typecheck:server
npm run test:integrations
npm run build
npm run patch:status
```

4. Restart locally with `npm run dev`, or deploy the updated repository through your normal Render flow.

## Configure Gemini for an account

1. Create/manage a Gemini API key in **Google AI Studio**. For current Gemini API access, use Google's current **Auth Key** flow rather than an old unrestricted standard API key.
2. Sign in to the target BA Client Ops Tracker account as an **Administrator**.
3. Open **Settings → AI Integration**.
4. Select **Gemini (Google AI Studio)**.
5. Enter the account's Gemini API key.
6. Keep `gemini-3.8-flash` or enter another Gemini model available to that Google project.
7. Enable the integration and click **Save settings**.
8. Click **Test saved connection**. A successful test confirms the credential and selected model are reachable.
9. Open **BA Assistant** and send a small test request.

## Existing OpenAI accounts

Existing OpenAI settings are preserved. They continue to use OpenAI unless an account administrator explicitly selects Gemini and supplies a new Gemini key. No existing encrypted key is exposed or migrated between providers.

## Server requirements

Keep the existing `TENANT_INTEGRATION_MASTER_KEY` unchanged. Changing that master key will make previously saved tenant credentials undecryptable. No Gemini key belongs in Render environment variables for this design; each tenant saves its own key through account Settings.

## Verification note

The release package was checked for patch structure, version transition, protected-file exclusions, and TypeScript/TSX syntax. A full dependency-backed build could not be completed in the packaging environment because `npm ci` exceeded the environment timeout, so run the four verification commands above on your v0.6.10 installation before deploying to production.
