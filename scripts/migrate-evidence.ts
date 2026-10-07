import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const connectionString = process.env.DATABASE_URL
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!connectionString || !supabaseUrl || !supabaseKey) throw new Error('DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are required.')
const pool = new pg.Pool({ connectionString, max: 2 })
const source = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function main() {
  const { rows } = await pool.query('select data from public.tenant_state')
  const evidence = new Map<string, string>()
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const entry = value as Record<string, unknown>
    if (typeof entry.storagePath === 'string' && entry.storagePath.startsWith('organizations/')) evidence.set(entry.storagePath, typeof entry.mimeType === 'string' ? entry.mimeType : 'application/octet-stream')
    Object.values(entry).forEach(visit)
  }
  rows.forEach(row => visit(row.data))
  let copied = 0
  for (const [path, mimeType] of evidence) {
    const { data, error } = await source.storage.from('task-evidence').download(path)
    if (error || !data) throw new Error(`Failed to download ${path}: ${error?.message || 'missing file'}`)
    const buffer = Buffer.from(await data.arrayBuffer())
    await pool.query('insert into public.tracker_evidence_files (bucket, storage_path, mime_type, content) values ($1,$2,$3,$4) on conflict (bucket, storage_path) do update set mime_type=excluded.mime_type, content=excluded.content', ['task-evidence', path, mimeType, buffer])
    copied++
  }
  console.log(`Copied ${copied} of ${evidence.size} referenced evidence files to PostgreSQL.`)
}
try { await main() } finally { await pool.end() }
