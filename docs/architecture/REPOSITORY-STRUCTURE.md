# Repository structure

BA Client Ops Tracker uses a predictable top-level layout:

```text
ba-client-ops-tracker/
├── .github/                 # CI workflows
├── database/                # Supabase migrations and database notes
├── docs/                    # Architecture, setup and release documentation
├── public/                  # Static browser assets
├── scripts/                 # Patch / rollback utilities
├── server/                  # Express backend grouped by responsibility
├── src/                     # React application
├── templates/               # Controlled document-generation templates
├── tests/                   # Automated tests
├── .env.example             # Safe environment-variable template
├── .gitignore
├── index.html
├── package.json
├── README.md
├── server.ts                # Stable backend entry point
└── tsconfig*.json
```

## Conventions

1. Keep the repository root limited to project entry/configuration files.
2. Put backend features in the appropriate `server/` responsibility folder.
3. Put database migrations only in `database/migrations/`.
4. Put release notes in `docs/releases/`; do not add new `UPGRADE-*.md` files to the root.
5. Generated full-build and patch ZIP files belong in release artifacts, not Git source control.
6. Never commit `.env`, secrets, local patch backups, `dist/`, `node_modules/`, logs or TypeScript build-info files.
7. Preserve the patch updater as the supported migration path between released versions.

## Frontend organization

The existing `src/` paths remain stable in v0.6.39 to avoid mixing a repository cleanup with a high-risk UI refactor. Future feature work can move frontend areas into `src/modules/`, `src/components/`, and `src/services/` incrementally with build/test validation in each release.
