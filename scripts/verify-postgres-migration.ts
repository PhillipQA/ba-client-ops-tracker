import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const connectionString = process.env.DATABASE_URL
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!connectionString || !supabaseUrl || !supabaseKey) throw new Error('DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required.')
const pool = new pg.Pool({ connectionString, max: 2 })
const source = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
const tables = ['organizations', 'platform_users', 'app_users', 'tenant_state', 'tenant_integrations', 'user_communications', 'user_github_connections', 'user_github_issues', 'user_gitlab_connections', 'user_gitlab_issues']

async function main() {
  const { rows: roleRows } = await pool.query('select current_user as name, rolbypassrls from pg_roles where rolname = current_user')
  if (!roleRows[0]?.rolbypassrls) {
    const { rows: rls } = await pool.query("select p.tablename from pg_tables p join pg_class c on c.relname=p.tablename join pg_namespace n on n.oid=c.relnamespace and n.nspname=p.schemaname where p.schemaname='public' and p.rowsecurity and (p.tableowner <> current_user or c.relforcerowsecurity)")
    if (rls.length) throw new Error(`PostgreSQL user ${roleRows[0]?.name} cannot bypass row level security on ${rls.length} imported tables.`)
  }
  let mismatch = false
  for (const table of tables) {
    const { count, error } = await source.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`Source ${table}: ${error.message}`)
    const { rows } = await pool.query(`select count(*)::int as count from public."${table}"`)
    const same = count === rows[0].count
    console.log(`${same ? 'OK' : 'DIFF'} ${table}: Supabase=${count} PostgreSQL=${rows[0].count}`)
    mismatch ||= !same
  }
  const { data, error } = await source.from('tenant_state').select('organization_id,updated_at').order('organization_id').limit(1000)
  if (error) throw error
  const { rows: states } = await pool.query('select organization_id, updated_at from public.tenant_state')
  const target = new Map(states.map(row => [String(row.organization_id), new Date(row.updated_at).getTime()]))
  for (const item of data || []) {
    const same = target.get(String(item.organization_id)) === new Date(item.updated_at).getTime()
    console.log(`${same ? 'OK' : 'DIFF'} tenant_state ${item.organization_id} revision`)
    mismatch ||= !same
  }
  if (mismatch) throw new Error('Migration differs from live Supabase data. Refresh the database backup before cutover.')
  console.log('Database row counts and workspace revisions match the current Supabase project.')
}
try { await main() } finally { await pool.end() }
