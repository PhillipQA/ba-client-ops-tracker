// The database: PostgreSQL (on Northflank), reached through DATABASE_URL. Without it the app still starts, and every
// feature that needs the database says it is not configured.
import './env'
import { createPostgresClient } from '../postgres-client'

export const db: any = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : null
