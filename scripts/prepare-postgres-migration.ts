import 'dotenv/config'
import pg from 'pg'

const appUri = process.env.DATABASE_URL
const adminUri = process.env.PG_ADMIN_URL
if (!appUri || !adminUri) throw new Error('DATABASE_URL and PG_ADMIN_URL are required.')
const appUrl = new URL(appUri)
const adminUrl = new URL(adminUri)
if (appUrl.host !== adminUrl.host || appUrl.pathname !== adminUrl.pathname) {
  throw new Error('The app and admin connection strings must point to the same Northflank database.')
}
if (appUrl.username === adminUrl.username) throw new Error('Use the separate POSTGRES_URI_ADMIN connection for PG_ADMIN_URL.')

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
const app = new pg.Client({ connectionString: appUri })
const admin = new pg.Client({ connectionString: adminUri })
try {
  await app.connect()
  const appRole = (await app.query('select current_user as name')).rows[0].name as string
  await admin.connect()
  await admin.query('begin')
  try {
    const tables = await admin.query(`
      select n.nspname, c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
      order by c.relname
    `)
    // This is a private, server-only copy. Supabase's browser/JWT policies are
    // inapplicable here; the Node server enforces tenant access for its DB role.
    for (const table of tables.rows) {
      await admin.query(`alter table ${quote(table.nspname)}.${quote(table.relname)} disable row level security`)
    }
    await admin.query(`
      create table if not exists public.tracker_evidence_files (
        bucket text not null,
        storage_path text not null,
        mime_type text not null,
        content bytea not null,
        created_at timestamptz not null default now(),
        primary key (bucket, storage_path)
      )
    `)
    await admin.query(`grant usage on schema public to ${quote(appRole)}`)
    await admin.query(`grant select, insert, update, delete on all tables in schema public to ${quote(appRole)}`)
    await admin.query(`grant usage, select, update on all sequences in schema public to ${quote(appRole)}`)
    await admin.query(`grant execute on all functions in schema public to ${quote(appRole)}`)
    await admin.query('commit')
    console.log(`Prepared ${tables.rowCount} imported tables and task evidence storage for the application role.`)
  } catch (error) {
    await admin.query('rollback')
    throw error
  }
} finally {
  await Promise.allSettled([app.end(), admin.end()])
}
