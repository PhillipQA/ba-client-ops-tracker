import type { SessionPersistence, StoredSession } from './session-store'

type Pool = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> }

/** Off for a while once the table is found missing (schema v47 not run yet): sessions then live in memory only. */
const MISSING_RETRY_MS = 10 * 60_000

function missingTable(error: unknown) {
  return (error as { code?: string })?.code === '42P01'
}

const iso = (ms: number) => new Date(ms).toISOString()
const ms = (value: unknown) => new Date(String(value)).getTime()

function row<T>(record: any): StoredSession<T> {
  return {
    user: record.user_data as T,
    createdAt: ms(record.created_at),
    lastSeenAt: ms(record.last_seen_at),
    flags: record.flags && typeof record.flags === 'object' ? record.flags : {},
  }
}

/**
 * Sessions kept in public.app_sessions (schema v47), keyed by a SHA-256 of the token. Until the table exists every
 * call is a quiet no-op (load says "nothing stored" is not known, so it throws and the server keeps its own copy);
 * the table is looked for again every ten minutes, so running the migration needs no restart.
 */
export function sessionDatabase<T extends { id?: unknown; organizationId?: unknown; accountType?: unknown }>(
  pool: Pool,
  options: { now?: () => number; warn?: (message: string) => void } = {},
): SessionPersistence<T> & { available: () => boolean } {
  const now = options.now ?? Date.now
  const warn = options.warn ?? (message => console.warn(message))
  let missingUntil = 0
  const run = async (sql: string, values: unknown[]) => {
    if (now() < missingUntil) throw Object.assign(new Error('Sessions table missing'), { code: '42P01', quiet: true })
    try {
      return await pool.query(sql, values)
    } catch (error) {
      if (missingTable(error)) {
        if (!missingUntil)
          warn(
            'Sessions are kept in memory only until database/migrations/schema-v47-sessions.sql is run: a restart signs everyone out.',
          )
        missingUntil = now() + MISSING_RETRY_MS
      }
      throw error
    }
  }
  const quietly = async (sql: string, values: unknown[]) => {
    try {
      await run(sql, values)
    } catch (error) {
      if (!missingTable(error)) throw error
    }
  }
  return {
    available: () => now() >= missingUntil,
    save: (key, session, expiresAt) =>
      quietly(
        `insert into public.app_sessions (token_hash,user_id,organization_id,account_type,user_data,flags,created_at,last_seen_at,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (token_hash) do update set user_id=excluded.user_id, organization_id=excluded.organization_id,
           account_type=excluded.account_type, user_data=excluded.user_data, flags=excluded.flags,
           last_seen_at=greatest(public.app_sessions.last_seen_at, excluded.last_seen_at), expires_at=excluded.expires_at`,
        [
          key,
          String(session.user?.id ?? ''),
          session.user?.organizationId ? String(session.user.organizationId) : null,
          session.user?.accountType === 'platform' ? 'platform' : 'tenant',
          JSON.stringify(session.user),
          JSON.stringify(session.flags || {}),
          iso(session.createdAt),
          iso(session.lastSeenAt),
          iso(expiresAt),
        ],
      ),
    touch: (key, lastSeenAt, expiresAt) =>
      quietly(
        'update public.app_sessions set last_seen_at=greatest(last_seen_at,$2), expires_at=greatest(expires_at,$3) where token_hash=$1',
        [key, iso(lastSeenAt), iso(expiresAt)],
      ),
    remove: key => quietly('delete from public.app_sessions where token_hash=$1', [key]),
    async load(key) {
      const result = await run(
        'select user_data, flags, created_at, last_seen_at from public.app_sessions where token_hash=$1',
        [key],
      )
      return result.rows[0] ? row<T>(result.rows[0]) : null
    },
    async loadAll(at) {
      const result = await run(
        'select token_hash, user_data, flags, created_at, last_seen_at from public.app_sessions where expires_at > $1',
        [iso(at)],
      )
      return result.rows.map(record => [String(record.token_hash), row<T>(record)] as [string, StoredSession<T>])
    },
    prune: at => quietly('delete from public.app_sessions where expires_at <= $1', [iso(at)]),
  }
}
