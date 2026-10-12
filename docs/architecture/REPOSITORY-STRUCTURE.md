# Repository structure

## Main paths

| Path | Contents |
| --- | --- |
| `src/` | React frontend |
| `server/` | Express backend grouped by responsibility |
| `server.ts` | Stable application server entry point |
| `database/` | Fresh Supabase setup, incremental migrations and selected combined upgrades |
| `templates/` | Controlled document-generation templates |
| `public/` | Static browser assets |
| `scripts/` | Patch tools, functional-check runner and database helpers |
| `tests/` | Automated regression checks |
| `docs/setup/` | Current installation, hosting and maintenance guides |
| `docs/releases/` | Version-specific historical release notes |
| `docs/releases/archive/` | Superseded bootstrap/patch instructions |
| `README.md` | Installation, environment, first login and deployment |
| `CHANGELOG.md` | Recent changes, newest first |
| `.env.example` | Safe configuration template |

## Conventions

1. Keep current setup guidance in the README and `docs/setup/`.
2. Keep a short newest-first changelog; link detailed version notes instead of repeating them.
3. Put release notes in `docs/releases/vX.Y.Z.md`. Do not add root `UPGRADE-*.md` or legacy patch-note files.
4. Preserve older instructions in the release archive; label superseded behavior when relevant.
5. Put database migrations in `database/migrations/`. Regenerate fresh setup with `npm run db:bundle` and check it with `npm run db:check`.
6. Keep source updates and official version-matched patch ZIP workflows distinct.
7. Publish generated ZIPs as release assets rather than committing them to Git.
8. Keep environment secrets, local patch backups, builds, dependencies and logs out of source control.

See the [documentation index](../README.md) and [release index](../releases/README.md).
