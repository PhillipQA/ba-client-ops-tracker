import pg from 'pg'

const { Pool, types } = pg
// Keep PostgreSQL's microseconds for optimistic workspace revision checks.
// Date#toISOString truncates them to milliseconds and causes false 409 conflicts.
types.setTypeParser(1184, value => value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
types.setTypeParser(1114, value => new Date(value.replace(' ', 'T') + 'Z').toISOString())

type Result = { data: any; error: any; count?: number | null }
type Predicate = { sql: string; values: unknown[]; jsonColumn?: string }

const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Invalid SQL identifier: ${name}`)
  return `"${name}"`
}
const filterColumn = (name: string) => {
  const jsonText = /^([a-z_][a-z0-9_]*)->>([a-z_][a-z0-9_]*)$/i.exec(name)
  return jsonText ? `(${identifier(jsonText[1])}->>'${jsonText[2]}')` : identifier(name)
}
const tableName = (name: string) => `public.${identifier(name)}`

export function createPostgresClient(connectionString: string, testPool?: Pick<pg.Pool, 'query'>) {
  const pool = testPool ?? new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 })
  const metadata = new Map<string, Promise<{ primary: string[]; json: Set<string> }>>()
  const meta = (table: string) => {
    let cached = metadata.get(table)
    if (!cached) {
      cached = (async () => {
        const [cols, keys] = await Promise.all([
          pool.query(
            `select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1`,
            [table],
          ),
          pool.query(
            `select a.attname from pg_index i join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid and a.attnum=any(i.indkey) where n.nspname='public' and t.relname=$1 and i.indisprimary order by a.attnum`,
            [table],
          ),
        ])
        if (!cols.rows.length) throw new Error(`Missing public table: ${table}`)
        return {
          primary: keys.rows.map(row => row.attname as string),
          json: new Set<string>(
            cols.rows.filter(row => ['json', 'jsonb'].includes(row.data_type)).map(row => row.column_name),
          ),
        }
      })()
      metadata.set(table, cached)
      cached.catch(() => metadata.delete(table))
    }
    return cached
  }
  const adapted = (value: unknown, column: string, json: Set<string>) =>
    json.has(column) && value !== null ? JSON.stringify(value) : value

  class Query {
    private action: 'read' | 'insert' | 'upsert' | 'update' | 'delete' = 'read'
    private values: Record<string, any>[] = []
    private conditions: Predicate[] = []
    private columns = '*'
    private returning = false
    private countRequested = false
    private head = false
    private sort: string[] = []
    private take?: number
    private offset?: number
    private one: 'single' | 'maybeSingle' | null = null
    private conflict?: string[]
    constructor(private table: string) {
      identifier(table)
    }
    select(columns = '*', options: { count?: string; head?: boolean } = {}) {
      this.columns = columns
      this.countRequested = options.count === 'exact'
      this.head = Boolean(options.head)
      if (this.action !== 'read') this.returning = true
      return this
    }
    insert(value: Record<string, any> | Record<string, any>[]) {
      this.action = 'insert'
      this.values = Array.isArray(value) ? value : [value]
      return this
    }
    upsert(value: Record<string, any> | Record<string, any>[], options: { onConflict?: string } = {}) {
      this.action = 'upsert'
      this.values = Array.isArray(value) ? value : [value]
      this.conflict = options.onConflict?.split(',').map(v => v.trim())
      return this
    }
    update(value: Record<string, any>) {
      this.action = 'update'
      this.values = [value]
      return this
    }
    delete() {
      this.action = 'delete'
      return this
    }
    private add(column: string, op: string, value: unknown) {
      this.conditions.push({ sql: `${filterColumn(column)} ${op} ?`, values: [value] })
      return this
    }
    eq(column: string, value: unknown) {
      return value === null ? this.is(column, null) : this.add(column, '=', value)
    }
    neq(column: string, value: unknown) {
      return this.add(column, '<>', value)
    }
    is(column: string, value: unknown) {
      if (value !== null) throw new Error('Only IS NULL is supported')
      this.conditions.push({ sql: `${identifier(column)} IS NULL`, values: [] })
      return this
    }
    ilike(column: string, value: string) {
      return this.add(column, 'ILIKE', value)
    }
    like(column: string, value: string) {
      return this.add(column, 'LIKE', value)
    }
    lt(column: string, value: unknown) {
      return this.add(column, '<', value)
    }
    lte(column: string, value: unknown) {
      return this.add(column, '<=', value)
    }
    gt(column: string, value: unknown) {
      return this.add(column, '>', value)
    }
    gte(column: string, value: unknown) {
      return this.add(column, '>=', value)
    }
    in(column: string, values: unknown[]) {
      this.conditions.push({ sql: `${identifier(column)} = ANY(?)`, values: [values] })
      return this
    }
    contains(column: string, values: unknown[]) {
      this.conditions.push({ sql: `${identifier(column)} @> ?`, values: [values], jsonColumn: column })
      return this
    }
    or(expression: string) {
      const parts = expression.split(',').map(part => /^([a-z_][a-z0-9_]*)\.eq\.(true|false)$/i.exec(part))
      if (parts.some(part => !part)) throw new Error('Unsupported OR filter')
      this.conditions.push({
        sql: `(${parts.map(part => `${identifier(part![1])} = ?`).join(' OR ')})`,
        values: parts.map(part => part![2] === 'true'),
      })
      return this
    }
    order(column: string, options: { ascending?: boolean } = {}) {
      this.sort.push(`${identifier(column)} ${options.ascending === false ? 'DESC' : 'ASC'}`)
      return this
    }
    limit(value: number) {
      this.take = value
      return this
    }
    range(first: number, last: number) {
      this.offset = first
      this.take = last - first + 1
      return this
    }
    single() {
      this.one = 'single'
      this.take = 1
      return this
    }
    maybeSingle() {
      this.one = 'maybeSingle'
      this.take = 1
      return this
    }
    private projection() {
      if (this.columns === '*') return '*'
      return this.columns
        .split(',')
        .map(part => {
          const item = part.trim()
          const json = /^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)->([a-z_][a-z0-9_]*)$/i.exec(item)
          if (json) return `${identifier(json[2])}->'${json[3]}' AS ${identifier(json[1])}`
          return identifier(item)
        })
        .join(', ')
    }
    private async execute(): Promise<Result> {
      try {
        const { primary, json } = await meta(this.table)
        const args: unknown[] = []
        const param = (value: unknown, column?: string) => {
          args.push(column ? adapted(value, column, json) : value)
          return `$${args.length}`
        }
        const buildWhere = (bind: (value: unknown) => string) =>
          this.conditions.length
            ? ` WHERE ${this.conditions
                .map(c => {
                  let index = 0
                  return c.sql.replace(/\?/g, () => {
                    const value = c.values[index++]
                    return bind(c.jsonColumn && json.has(c.jsonColumn) ? JSON.stringify(value) : value)
                  })
                })
                .join(' AND ')}`
            : ''
        const where = buildWhere(value => param(value))
        let sql: string
        if (this.action === 'read') {
          sql = `SELECT ${this.projection()} FROM ${tableName(this.table)}${where}`
          if (this.sort.length) sql += ` ORDER BY ${this.sort.join(', ')}`
          if (this.take !== undefined) sql += ` LIMIT ${param(this.take)}`
          if (this.offset !== undefined) sql += ` OFFSET ${param(this.offset)}`
        } else if (this.action === 'insert' || this.action === 'upsert') {
          if (!this.values.length) return { data: null, error: null }
          const columns = [...new Set(this.values.flatMap(row => Object.keys(row)))]
          sql = `INSERT INTO ${tableName(this.table)} (${columns.map(identifier).join(', ')}) VALUES ${this.values.map(row => `(${columns.map(col => (col in row ? param(row[col], col) : 'DEFAULT')).join(', ')})`).join(', ')}`
          if (this.action === 'upsert') {
            const key = this.conflict ?? primary
            if (!key.length) throw new Error(`No conflict key for ${this.table}`)
            const updates = columns.filter(col => !key.includes(col))
            sql += ` ON CONFLICT (${key.map(identifier).join(', ')}) ${updates.length ? `DO UPDATE SET ${updates.map(col => `${identifier(col)} = EXCLUDED.${identifier(col)}`).join(', ')}` : 'DO NOTHING'}`
          }
          if (this.returning) sql += ` RETURNING ${this.projection()}`
        } else if (this.action === 'update') {
          if (!where) throw new Error('Refusing unfiltered update')
          const changes = Object.entries(this.values[0])
          sql = `UPDATE ${tableName(this.table)} SET ${changes.map(([col, val]) => `${identifier(col)} = ${param(val, col)}`).join(', ')}${where}`
          if (this.returning) sql += ` RETURNING ${this.projection()}`
        } else {
          if (!where) throw new Error('Refusing unfiltered delete')
          sql = `DELETE FROM ${tableName(this.table)}${where}`
          if (this.returning) sql += ` RETURNING ${this.projection()}`
        }
        let count: number | null = null
        if (this.countRequested) {
          const countArgs: unknown[] = []
          const countWhere = buildWhere(value => {
            countArgs.push(value)
            return `$${countArgs.length}`
          })
          count = Number(
            (await pool.query(`SELECT count(*)::int AS n FROM ${tableName(this.table)}${countWhere}`, countArgs))
              .rows[0].n,
          )
        }
        if (this.head) return { data: null, error: null, count }
        const result = await pool.query(sql, args)
        let data: any = this.action === 'read' || this.returning ? result.rows : null
        if (this.one) {
          if (result.rows.length === 0 && this.one === 'single') throw new Error('No rows returned')
          data = result.rows[0] ?? null
        }
        return { data, error: null, count }
      } catch (error) {
        return { data: null, error, count: null }
      }
    }
    then<TResult1 = Result, TResult2 = never>(
      onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return this.execute().then(onfulfilled, onrejected)
    }
  }

  return {
    from(table: string) {
      return new Query(table)
    },
    // Evidence files live in the tracker_evidence_files table, behind a small upload/download/remove API.
    storage: {
      from(bucket: string) {
        return {
          async upload(filePath: string, data: Buffer, options: { contentType?: string } = {}) {
            try {
              await pool.query(
                'INSERT INTO public.tracker_evidence_files (bucket, storage_path, mime_type, content) VALUES ($1,$2,$3,$4)',
                [bucket, filePath, options.contentType || 'application/octet-stream', data],
              )
              return { data: { path: filePath }, error: null }
            } catch (error) {
              return { data: null, error }
            }
          },
          async download(filePath: string) {
            try {
              const result = await pool.query(
                'SELECT content, mime_type FROM public.tracker_evidence_files WHERE bucket=$1 AND storage_path=$2',
                [bucket, filePath],
              )
              if (!result.rows.length) throw new Error('Evidence file is missing from PostgreSQL storage.')
              return {
                data: new Blob([new Uint8Array(result.rows[0].content)], { type: result.rows[0].mime_type }),
                error: null,
              }
            } catch (error) {
              return { data: null, error }
            }
          },
          async remove(paths: string[]) {
            try {
              await pool.query(
                'DELETE FROM public.tracker_evidence_files WHERE bucket=$1 AND storage_path = ANY($2::text[])',
                [bucket, paths],
              )
              return { data: paths, error: null }
            } catch (error) {
              return { data: null, error }
            }
          },
        }
      },
    },
    async rpc(name: string, params: Record<string, any>) {
      try {
        identifier(name)
        const values = Object.values(params)
        const named = Object.keys(params).map((key, index) => `${identifier(key)} => $${index + 1}`)
        const result = await pool.query(
          `SELECT public.${identifier(name)}(${named.join(', ')}) AS result`,
          values.map(value => (value && typeof value === 'object' ? JSON.stringify(value) : value)),
        )
        return { data: result.rows[0]?.result ?? null, error: null }
      } catch (error) {
        return { data: null, error }
      }
    },
    pool,
  }
}
