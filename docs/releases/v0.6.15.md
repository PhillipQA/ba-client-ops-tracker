# Upgrade to v0.6.15 — DRF COR Extraction Mode

## Summary

v0.6.15 adds a selectable COR extraction method to **Document Creation → DRF Creation**. Local extraction remains the default. AI Enhanced extraction is optional and uses the AI integration configured for the current tenant/account.

## New behavior

- **Local Extractor (default)**
  - Runs OCR/text extraction and field matching in the browser.
  - Does not call the tenant AI provider.
  - Does not require an AI API key.
- **AI Enhanced**
  - Available only when the current tenant has an enabled AI provider/API key.
  - The browser first reads/OCRs the COR locally.
  - Only the extracted COR text is sent to the server-side tenant AI provider for mapping/refinement.
  - The COR file itself is not uploaded to the AI extraction endpoint.
  - Maps Business / Registered Name, Trade Name, TIN, and Registered Address.
  - AI results remain editable and should be reviewed before DRF generation.

## UI

A COR Extraction Method toggle appears above the COR upload area. It always starts on **Local**. If AI is not configured/enabled for the tenant, **AI Enhanced** is disabled and the UI explains that Account Settings must be configured first.

## Server/API

- `GET /api/documents/drf/ai-status` returns AI availability plus the non-secret provider/model identity for authorized Document Creation users.
- `POST /api/documents/drf/extract-cor-ai` accepts locally extracted COR text and returns the four mapped DRF fields.
- Tenant API credentials remain encrypted and server-side.

## Database / dependencies

No new Supabase migration is required. No new npm dependency is required. This feature reuses the existing tenant AI integration from v0.6.8+ and the existing local COR OCR pipeline.

## Suggested validation

1. Open DRF Creation with no tenant AI configured: Local should be selected and AI Enhanced should be disabled.
2. Configure/enable a tenant AI provider, reload DRF Creation, and confirm AI Enhanced becomes selectable.
3. Extract the same COR in Local mode and AI Enhanced mode and compare the four mapped fields.
4. Confirm the mode returns to Local on a fresh page/app session.
5. Confirm the COR file itself is not included in the AI request; only extracted text is posted.
6. Confirm DRF generation continues to use the persistent account template from v0.6.14.
