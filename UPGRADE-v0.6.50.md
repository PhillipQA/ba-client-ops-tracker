# Upgrade to v0.6.50

Hotfix for the v0.6.49 Document Creation build.

## Fix

- Restores the missing `ClipboardCheck` Lucide icon import used by the Test Case Creation card.
- No feature behavior, database schema, or dependency changes.

## Apply

```bat
npm run patch -- "C:\path\to\ba-client-ops-patch-v0.6.50-document-icon-hotfix.zip"
npm run build
```

No `npm install` or database migration is required.
