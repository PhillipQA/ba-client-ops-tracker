# Working on this repo

## Branch flow
1. Branch from `hotfix` for every change (`git checkout -b <name> origin/hotfix`).
2. Open the pull request into **`hotfix`**, never straight into `main`.
3. Wait for Build and End-to-end tests to pass. The owner reviews and merges; never merge without their approval.
4. When `hotfix` is ready to release, open one pull request from `hotfix` into `main`. Merging it deploys and bumps the build number.

If `hotfix` falls behind `main` (for example after a direct fix on `main`), merge `main` into `hotfix` through a pull request before branching.

## Database changes
Schema changes go in a new `database/migrations/schema-vNN-*.sql` file and are folded into `database/schema.sql`. Remind the owner to run the migration on the live database before deploying.
