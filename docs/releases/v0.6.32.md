# Upgrade to v0.6.32

This patch upgrades BA Client Ops Tracker **v0.6.31** to **v0.6.32**.

## Included

- Inline processing panel across DRF, FSD, Test Case, and Sign Off creation.
- Animated spinner and indeterminate progress bar while work is running.
- Workflow-specific stages for upload, extraction, mapping, generation, review, and download.
- “Still working” guidance after 10 seconds for larger documents.
- Clear success and failure states, with safe retry support for DRF and FSD workflows.
- Existing busy-state controls continue to prevent duplicate submissions.

## Apply

```bat
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.32-document-processing.zip"
```

No database migration, environment change, or new dependency is required.
