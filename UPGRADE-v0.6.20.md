# Upgrade to v0.6.20

v0.6.20 adds **Document Creation → Test Case Creation (Basic Mode)**.

## New Test Case Creator

- Upload and combine up to 20 requirement sources: BRD, FSD, User Stories, Acceptance Criteria, Change Requests, meeting notes, supporting documents, chat/pasted text, and screenshots/images.
- Supported readable files: PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG/JPEG, WEBP, BMP, TIFF.
- Uses the tenant/account AI provider already configured in Settings. No new API key or environment variable is required.
- Reusable built-in testing skills: Functional, UAT, Regression, Negative & Edge Cases, UI/UX, API & Integration, Mobile, and End-to-End.
- Users can create and reuse custom testing skills. Custom skills are retained for the current account/user browser profile.
- AI first generates a **Test Coverage Map** with traceable requirement IDs, source citations, planned scenarios, and clarification gaps.
- Coverage titles and scenarios are editable before detailed generation.
- AI then generates editable test cases with TC ID, Module, Requirement Reference, Scenario, Preconditions, Steps, Expected Result, Priority, Type, Test Data, Platform, Automation Candidate, and Remarks.
- Test rows can be edited, added, duplicated, or removed before export.
- Includes an **AI Coverage Review** showing covered requirements and remaining findings/ambiguities.
- Exports the reviewed/edited suite as `.xlsx` with a frozen header, filters, wrapped cells, and QA-friendly column widths.

## Guardrails

- Source documents are treated as evidence, not prompt instructions.
- AI is instructed not to invent unsupported requirements or expected behavior.
- Missing expected behavior is marked `TBD — clarification required` and surfaced in coverage findings.
- Every generated case must trace to a known mapped requirement.

## Compatibility

- Builds on v0.6.19.
- Existing DRF, FSD, Sign Off, Themes, authentication, tenant integrations, and other modules are unchanged.
- No database migration is required.
- No new npm dependency is required.
