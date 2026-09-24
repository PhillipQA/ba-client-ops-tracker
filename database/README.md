# Database

Supabase SQL migrations live in `database/migrations/`.

Apply migrations in version order for a new environment. Existing environments should only apply migrations newer than the schema already installed. Never place production credentials or exported tenant data in this directory.

Current migration files preserve their historical filenames so existing release notes and deployment history remain traceable.
