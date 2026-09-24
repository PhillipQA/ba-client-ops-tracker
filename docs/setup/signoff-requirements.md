# BA Client Ops Tracker Sign Off Requirements

Confirmed September 20, 2026 for the iRipple BA Project. Implemented in the v0.6.7 release package; hosted deployment remains a separate step. Ollama integration remains paused.

Reference: the user's SO GO-Live - Roving-POS.docx, identity libfile_1f39e52463cc8191a078ad466e4a849e. Preserve the original sample.

## Confirmed instructions

1. Retain the iRipple logo, document title, and header layout; customize the client in the PAF reference.
2. The client heading follows the client for this document.
3. Agreed and Approved has three iRipple and three client signatories, with editable text fields.
4. Target Deployment Date exports as MM/DD/YYYY.
5. Deployment Type dropdown: Production - New Site; Production - Head Office; Production - Branch.
6. Product Deployed dropdown: Barter RPOS 5.1; Barter FPOS 5.1; Barter CX v1.1; Barter CX v1.0.
7. Site Code / Name is customizable.
8. Client Name in the details follows the document client.
9. Retain Purpose from the sample.
10. Retain Scope from the sample.
11. Retain Deployment Authorization from the sample. This latest instruction supersedes the earlier Deployment History label.
12. Allow attachments, usually three or four images.

## Implementation choices

- Output is editable Word. Uploaded JPEG/PNG/WEBP images appear on attachment pages; other supported files accompany it in a ZIP.
- One editable client field populates all client references. Existing account clients are offered as suggestions.
- Six name/position pairs; unused pairs may stay blank. Signature/date lines are left for approval.
- Date-only output, since the requested format contains no time.
- Reference follows sample PAF-CLIENT-YYYY-01 style; spaces/punctuation removed in the client reference only. Year and sequence are editable; no automatic number reservation/increment.
- Fixed Purpose/Scope/Authorization text remains unchanged for every dropdown selection.
- Optional image captions and ordering. Limits: 20 files, 5 MB per file, 12 MB total after preparation; images resized to 1,800-pixel long edge.
- Administrators/Contributors with Document Creation access can generate; Viewers cannot.
- Session-only draft fields/attachments; generated files are downloaded, not stored as account records.
- No AI service, local runner, new dependency, or database migration is needed.

See UPGRADE-v0.6.7.md in the release package for installation, validation, and deployment checks.
