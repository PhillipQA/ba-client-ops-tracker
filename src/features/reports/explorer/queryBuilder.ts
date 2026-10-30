// Data explorer: the no-code builder. People pick a table, a join, filters and totals; it writes the SQL.
import { quoteName, sqlLiteral, type SqlColumnType } from './sqlEngine'
import type { TableInfo } from './explorerTables'

export type BuilderFilterOp = 'is' | 'is_not' | 'contains' | 'gte' | 'lte' | 'empty' | 'not_empty' | 'true' | 'false'
export type BuilderFilter = {
  column: string
  op: BuilderFilterOp
  value: string
  /** Asked for each time the query runs, as {{parameter}}. */
  ask: boolean
}
export type BuilderSummary = 'rows' | 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct'
export type Builder = {
  table: string
  join: string
  filters: BuilderFilter[]
  summary: BuilderSummary
  measure: string
  groupBy: string[]
  /** Dates in groups: by day as they are, or by week or month. */
  bucket: 'day' | 'week' | 'month'
  columns: string[]
  sort: 'value_desc' | 'value_asc' | 'group' | 'none'
  limit: number
}

export const emptyBuilder = (table = 'tasks'): Builder => ({
  table,
  join: '',
  filters: [],
  summary: 'count',
  measure: '',
  groupBy: table === 'tasks' ? ['tasks.status'] : [],
  bucket: 'month',
  columns: [],
  sort: 'value_desc',
  limit: 100,
})

/** Tables that link to each other, and the columns that link them: from.column → to.column. */
const LINKS: [string, string, string, string][] = [
  ['tasks', 'client_id', 'clients', 'id'],
  ['tasks', 'project_id', 'projects', 'id'],
  ['tasks', 'assignee_id', 'users', 'id'],
  ['time_entries', 'task_id', 'tasks', 'id'],
  ['time_entries', 'user_id', 'users', 'id'],
  ['time_entries', 'client_id', 'clients', 'id'],
  ['time_entries', 'project_id', 'projects', 'id'],
  ['activities', 'client_id', 'clients', 'id'],
  ['activities', 'project_id', 'projects', 'id'],
  ['activity_log', 'task_id', 'tasks', 'id'],
  ['activity_log', 'client_id', 'clients', 'id'],
  ['messages', 'task_id', 'tasks', 'id'],
  ['messages', 'client_id', 'clients', 'id'],
]
export type Join = { key: string; table: string; on: string; label: string }
/** The joins the builder offers from a table, in both directions. */
export function joinsFrom(table: string): Join[] {
  const joins: Join[] = []
  for (const [from, fromColumn, to, toColumn] of LINKS) {
    if (from === table)
      joins.push({
        key: `${to}:${fromColumn}`,
        table: to,
        on: `${to}.${toColumn} = ${from}.${fromColumn}`,
        label: `${to} (by ${fromColumn})`,
      })
    if (to === table && from !== table)
      joins.push({
        key: `${from}:${fromColumn}`,
        table: from,
        on: `${from}.${fromColumn} = ${to}.${toColumn}`,
        label: `${from} (their ${fromColumn})`,
      })
  }
  return joins
}

/** Every column the builder can use: table.column, with its type. */
export function builderColumns(builder: Builder, catalog: TableInfo[]) {
  const join = joinsFrom(builder.table).find(item => item.key === builder.join)
  return [builder.table, join?.table]
    .filter((name): name is string => Boolean(name))
    .flatMap(name =>
      (catalog.find(table => table.name === name)?.columns || []).map(column => ({
        key: `${name}.${column.name}`,
        table: name,
        name: column.name,
        type: column.type,
      })),
    )
}

const ref = (key: string) =>
  key
    .split('.')
    .map(part => quoteName(part))
    .join('.')
/** The parameter a filter asks for: clients.name asks for {{client}}, tasks.due_date for {{due_date}}. */
const paramName = (key: string) => {
  const [table, column = table] = key.split('.')
  if (column === 'name' || column === 'id') return `${table.replace(/s$/, '')}${column === 'id' ? '_id' : ''}`
  return column.replace(/[^a-z0-9_]+/g, '_')
}

/** The conditions that compare with a value. */
const VALUED: BuilderFilterOp[] = ['is', 'is_not', 'contains', 'gte', 'lte']

function test(filter: BuilderFilter, column: string, value: string) {
  switch (filter.op) {
    case 'is':
      return `${column} = ${value}`
    case 'is_not':
      return `${column} <> ${value}`
    case 'contains':
      return filter.ask ? `${column} LIKE '%' || ${value} || '%'` : `${column} LIKE ${sqlLiteral(`%${filter.value}%`)}`
    case 'gte':
      return `${column} >= ${value}`
    case 'lte':
      return `${column} <= ${value}`
    case 'empty':
      return `${column} IS NULL`
    case 'not_empty':
      return `${column} IS NOT NULL`
    case 'true':
      return `${column} = TRUE`
    default:
      return `${column} = FALSE`
  }
}

/** The SQL the builder's choices make. */
export function builderSql(builder: Builder, catalog: TableInfo[]): string {
  const columns = builderColumns(builder, catalog)
  const typeOf = (key: string): SqlColumnType => columns.find(column => column.key === key)?.type || 'text'
  const literal = (key: string, value: string) => {
    const type = typeOf(key)
    if (type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) return String(Number(value))
    if (type === 'bool') return /^(true|yes|1)$/i.test(value.trim()) ? 'TRUE' : 'FALSE'
    return sqlLiteral(value)
  }
  const join = joinsFrom(builder.table).find(item => item.key === builder.join)
  const where = builder.filters
    .filter(filter => columns.some(column => column.key === filter.column))
    // A condition still waiting for its value counts every row, rather than none.
    .filter(filter => filter.ask || !VALUED.includes(filter.op) || filter.value.trim() !== '')
    .map(filter => {
      const column = ref(filter.column)
      const value = filter.ask ? `{{${paramName(filter.column)}}}` : literal(filter.column, filter.value)
      const condition = test(filter, column, value)
      // A value asked for each time may be left empty: then the condition is skipped and every row counts.
      return filter.ask && VALUED.includes(filter.op) ? `(${value} IS NULL OR ${condition})` : condition
    })
  const groups = builder.groupBy
    .filter(key => columns.some(column => column.key === key))
    .map(key => {
      const name = key.split('.').pop() || key
      if (typeOf(key) === 'date' && builder.bucket !== 'day') {
        const alias = `${builder.bucket}_of_${name}`.replace(/_date$/, '')
        return { expr: `${builder.bucket === 'week' ? 'WEEK_START' : 'MONTH_START'}(${ref(key)})`, alias }
      }
      return { expr: ref(key), alias: '' }
    })
  const lines: string[] = []
  let valueAlias = ''
  if (builder.summary === 'rows') {
    const picked = builder.columns.filter(key => columns.some(column => column.key === key))
    lines.push(`SELECT ${picked.length ? picked.map(ref).join(', ') : `${quoteName(builder.table)}.*`}`)
  } else {
    const measure = columns.find(column => column.key === builder.measure)
    const measureName = measure?.name || 'value'
    let total = 'COUNT(*)'
    valueAlias = 'count'
    if (builder.summary === 'count_distinct' && measure) {
      total = `COUNT(DISTINCT ${ref(measure.key)})`
      valueAlias = `distinct_${measureName}`
    } else if (builder.summary !== 'count' && builder.summary !== 'count_distinct' && measure) {
      total = `${builder.summary.toUpperCase()}(${ref(measure.key)})`
      valueAlias = `${builder.summary}_${measureName}`
    }
    lines.push(
      `SELECT ${[...groups.map(group => (group.alias ? `${group.expr} AS ${group.alias}` : group.expr)), `${total} AS ${valueAlias}`].join(', ')}`,
    )
  }
  lines.push(`FROM ${quoteName(builder.table)}`)
  if (join) lines.push(`LEFT JOIN ${quoteName(join.table)} ON ${join.on}`)
  if (where.length) lines.push(`WHERE ${where.join('\n  AND ')}`)
  if (builder.summary !== 'rows' && groups.length)
    lines.push(`GROUP BY ${groups.map(group => group.alias || group.expr).join(', ')}`)
  if (builder.summary !== 'rows' && builder.sort !== 'none') {
    if (builder.sort === 'group' && groups.length)
      lines.push(`ORDER BY ${groups.map(group => group.alias || group.expr).join(', ')}`)
    else if (builder.sort !== 'group')
      lines.push(`ORDER BY ${valueAlias} ${builder.sort === 'value_desc' ? 'DESC' : 'ASC'}`)
  }
  if (builder.limit > 0) lines.push(`LIMIT ${Math.min(5000, Math.round(builder.limit))}`)
  return lines.join('\n')
}
