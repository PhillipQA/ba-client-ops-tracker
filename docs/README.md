# Documentation

Start with the [installation README](../README.md). The [changelog](../CHANGELOG.md) lists recent changes without mixing them into setup instructions.

## Setup and maintenance

| Guide | Use it for |
| --- | --- |
| [Install locally](../README.md#install-locally) | Source, dependencies, environment and first login |
| [Build and deploy](../README.md#build-and-deploy) | Production build and application start commands |
| [Deploy on a new server](setup/deploy-new-server.md) | Moving hosting while keeping the correct database and keys |
| [Database setup](../database/README.md) | Choosing fresh setup or incremental migrations |
| [Upgrade an existing installation](setup/upgrade.md) | Current update commands, migration requirements and patch ZIPs |
| [Northflank PostgreSQL cutover](setup/northflank-postgres-cutover.md) | Importing existing Supabase data and transferring evidence |
| [Password recovery](setup/password-recovery.md) | SMTP settings, registered emails and recovery checks |

## Product and repository reference

- [Sign Off Document mapping](setup/signoff-requirements.md)
- [Repository structure](architecture/REPOSITORY-STRUCTURE.md)
- [Release archive](releases/README.md)

Historical notes describe their original release. Use the current README and upgrade guide when installing the current version.
