# BA Client Ops Tracker v0.6.38

## Document History: Active + Archive

This release reorganizes **Document Creation → Document History** so active signing work stays compact and completed/voided records remain available for audit tracking.

### What changed

- Global Document History now has two folders/tabs:
  - **Active** — documents still being created, prepared, routed, reviewed, or signed.
  - **Archive** — documents whose status is `Done`, `Complete/Completed`, or `Void/Voided`.
- Completed and voided documents are no longer shown in the default Active view.
- Archive is non-destructive. The existing DocHub document record, signatories, timestamps, activity events, task link, and PDF access remain available.
- Global history uses a compact responsive **tile layout** to reduce vertical space. Tiles show document type, status, creator, creation time, signature progress, follow-up, and quick actions.
- **Details** opens the full signatory/activity view in a modal instead of keeping every timeline expanded in the page.
- New DocHub preparations save the creator's display name with the record.
- Existing DocHub records resolve the creator name from the tenant user list when possible, so older documents can also show who created them.
- Task/subtask **Linked documents** keep their existing full history view so completed documents remain visible beside the work record and completion prompts continue to work.

### Archive status rules

The Active/Archive split recognizes these archive statuses case-insensitively:

- `DONE`
- `COMPLETE`
- `COMPLETED`
- `VOID`
- `VOIDED`

Statuses such as Rejected, Expired, Upload Failed, Review Required, and other exception states remain in **Active** because they may still require user action.

### Upgrade

From v0.6.37:

```bat
cd /d E:\Playwright\ba-client-ops-tracker
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.38-document-history-archive.zip"
npm run patch:status
npm run build
```

No new npm package, Render environment variable, or Supabase migration is required. Creator tracking is stored inside the existing DocHub document JSON record.

### Validation performed

- Patch package applies cleanly from v0.6.37 to v0.6.38.
- Modified TypeScript/TSX files pass TypeScript syntax transpilation.
- Archive status classification was checked for Done/Complete/Completed/Void/Voided versus ongoing/error statuses.
- Full dependency-based `npm run build` could not be completed in the generation environment because npm dependencies were unavailable there; run the command above in the existing project installation as the final environment check.
