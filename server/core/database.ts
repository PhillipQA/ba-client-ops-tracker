// The database client (Supabase or plain Postgres).
import './env'
import { createClient } from '@supabase/supabase-js'
import { createPostgresClient } from '../postgres-client'

const supabaseUrl = process.env.SUPABASE_URL

const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const databaseProvider = process.env.DATABASE_PROVIDER === 'postgres' ? 'postgres' : 'supabase'

if (databaseProvider === 'postgres' && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL mode.')

export const supabaseAdmin: any = databaseProvider === 'postgres'
  ? createPostgresClient(process.env.DATABASE_URL!)
  : supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null
