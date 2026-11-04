// Data explorer: query the account's data with SQL (or the builder, which writes the SQL), see the result as a grid
// or a chart, and save queries to reuse, share as templates, or put on reports. Everything runs in the browser.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  FilePlus2,
  LayoutTemplate,
  Lock,
  Play,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { Dialog, Notice } from '../../../shared/ui'
import type { Client, Project, UserAccount } from '../../../shared/types'
import {
  freeSpot,
  newWidget,
  QUERY_VIEWS,
  WIDGET_SIZES,
  type QueryView,
  type ReportDefinition,
  type ReportItem,
  type SavedQuery,
} from '../custom/reportModel'
import type { ReportPatch } from '../custom/reportApi'
import {
  builderColumns,
  builderSql,
  emptyBuilder,
  joinsFrom,
  type Builder,
  type BuilderFilter,
  type BuilderFilterOp,
  type BuilderSummary,
} from './queryBuilder'
import { QueryResultView } from './QueryResult'
import { resultCsv } from './resultView'
import { isKeyword, queryParams, tableIdentifierParams, SQL_FUNCTIONS, SqlError, type SqlResult } from './sqlEngine'
import { paramsForReport } from './reportParams'
import type { TableInfo } from './explorerTables'
import { csvText } from '../../../shared/csv'

export const VIEW_LABELS: Record<QueryView, string> = {
  table: 'Table',
  bar: 'Bar',
  column: 'Column',
  line: 'Line',
  pie: 'Pie',
  number: 'Number',
}
const SUMMARIES: { value: BuilderSummary; label: string; measure: boolean }[] = [
  { value: 'count', label: 'Count of rows', measure: false },
  { value: 'count_distinct', label: 'Number of different…', measure: true },
  { value: 'sum', label: 'Total of…', measure: true },
  { value: 'avg', label: 'Average of…', measure: true },
  { value: 'min', label: 'Lowest…', measure: true },
  { value: 'max', label: 'Highest…', measure: true },
  { value: 'rows', label: 'Just the rows', measure: false },
]
const FILTER_OPS: { value: BuilderFilterOp; label: string; needsValue: boolean }[] = [
  { value: 'is', label: 'is', needsValue: true },
  { value: 'is_not', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'gte', label: 'is on or after / at least', needsValue: true },
  { value: 'lte', label: 'is on or before / at most', needsValue: true },
  { value: 'empty', label: 'is empty', needsValue: false },
  { value: 'not_empty', label: 'is filled in', needsValue: false },
  { value: 'true', label: 'is yes', needsValue: false },
  { value: 'false', label: 'is no', needsValue: false },
]
const SQL_WORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'LEFT JOIN',
  'JOIN',
  'ON',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'BETWEEN',
  'IS NULL',
  'IS NOT NULL',
  'CASE WHEN',
  'THEN',
  'ELSE',
  'END',
  'AS',
  'DISTINCT',
  'DESC',
  'ASC',
  'CURRENT_DATE',
]
const START_SQL =
  'SELECT status, COUNT(*) AS tasks\nFROM tasks\nWHERE done = FALSE\nGROUP BY status\nORDER BY tasks DESC'

function downloadCsv(name: string, rows: string[][]) {
  // Formula-safe: text such as an email subject starting with = stays text when the file is opened.
  const blob = new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'query'}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

type Explorer = {
  catalog: TableInfo[]
  run: (sql: string, params: Record<string, string>) => Promise<SqlResult>
  loadTrackers: () => Promise<unknown>
  today: string
  trackersLoaded: boolean
}

export function DataExplorer({
  switcher,
  explorer,
  queries,
  reports,
  clients,
  projects,
  accounts,
  isAdmin,
  canChange,
  busy,
  problem,
  onDismissProblem,
  create,
  update,
  remove,
  openReport,
}: {
  /** The Reports | Data explorer switch, at the top of the sidebar. */
  switcher: ReactNode
  explorer: Explorer
  /** Saved queries this person can see: their own, and the shared templates. */
  queries: ReportItem[]
  /** Reports this person may add a query to. */
  reports: ReportItem[]
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  isAdmin: boolean
  canChange: boolean
  busy: boolean
  /** A save that did not work. */
  problem: string
  onDismissProblem: () => void
  create: (body: {
    kind: 'report' | 'query'
    name: string
    description?: string
    shared?: boolean
    definition?: ReportDefinition
  }) => Promise<ReportItem | null>
  update: (item: ReportItem, patch: ReportPatch) => Promise<ReportItem | null>
  remove: (item: ReportItem) => Promise<void>
  openReport: (id: string) => void
}) {
  const [openId, setOpenId] = useState('')
  const [sql, setSql] = useState(START_SQL)
  const [params, setParams] = useState<Record<string, string>>({})
  const [view, setView] = useState<QueryView>('table')
  const [builder, setBuilder] = useState<Builder | null>(null)
  const [result, setResult] = useState<SqlResult | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string[]>(['tasks'])
  const [dialog, setDialog] = useState<'save' | 'add' | null>(null)
  const [caret, setCaret] = useState(0)
  const editor = useRef<HTMLTextAreaElement>(null)
  const opened = queries.find(item => item.id === openId) || null
  const names = queryParams(sql)
  const identifierParams = tableIdentifierParams(sql)
  useEffect(() => {
    if (identifierParams.length) void explorer.loadTrackers()
  }, [identifierParams.length, explorer.loadTrackers])

  // --- Running ---

  const run = async (text = sql, given = params) => {
    setRunning(true)
    setError('')
    try {
      const values = Object.fromEntries(queryParams(text).map(name => [name, given[name] ?? '']))
      setResult(await explorer.run(text, values))
    } catch (problem) {
      setResult(null)
      if (problem instanceof SqlError) {
        const line = problem.position >= 0 ? text.slice(0, problem.position).split('\n').length : 0
        setError(line ? `Line ${line}: ${problem.message}` : problem.message)
      } else setError('The query could not run. Try again.')
    } finally {
      setRunning(false)
    }
  }

  // --- Builder ---

  const applyBuilder = (next: Builder) => {
    setBuilder(next)
    setSql(builderSql(next, explorer.catalog))
  }
  const columns = builder ? builderColumns(builder, explorer.catalog) : []
  const setFilter = (index: number, patch: Partial<BuilderFilter>) =>
    builder &&
    applyBuilder({
      ...builder,
      filters: builder.filters.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    })

  // --- Autocomplete: the word being typed, and what could finish it ---

  // Short names given to tables in the query (FROM tasks t), so t. offers the columns of tasks.
  const aliases = useMemo(() => {
    const found = new Map<string, string>()
    for (const match of sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi)) {
      const table = match[1].toLowerCase()
      const alias = match[2]?.toLowerCase()
      if (alias && !isKeyword(alias)) found.set(alias, table)
    }
    return found
  }, [sql])
  const word = useMemo(() => {
    const before = sql.slice(0, caret)
    const match = /([A-Za-z_][A-Za-z0-9_]*\.?[A-Za-z0-9_]*)$/.exec(before)
    return match ? match[1] : ''
  }, [sql, caret])
  const suggestions = useMemo(() => {
    if (word.length < 2 && !word.endsWith('.')) return []
    const lower = word.toLowerCase()
    if (lower.includes('.')) {
      const [prefix, start] = lower.split('.')
      const table = aliases.get(prefix) || prefix
      const columnsOf = explorer.catalog.find(item => item.name === table)?.columns || []
      return columnsOf
        .map(column => `${prefix}.${column.name}`)
        .filter(name => name.startsWith(`${prefix}.${start}`) && name !== lower)
        .slice(0, 8)
    }
    const used = explorer.catalog.filter(table => new RegExp(`\\b${table.name}\\b`, 'i').test(sql))
    const pool = [
      ...explorer.catalog.map(table => table.name),
      ...used.flatMap(table => table.columns.map(column => column.name)),
      ...SQL_WORDS,
      ...SQL_FUNCTIONS.map(name => `${name.toUpperCase()}(`),
    ]
    return [...new Set(pool)]
      .filter(item => item.toLowerCase().startsWith(lower) && item.toLowerCase() !== lower)
      .slice(0, 8)
  }, [word, sql, explorer.catalog, aliases])
  const insert = (text: string, replace = word) => {
    const start = caret - replace.length
    const next = sql.slice(0, start) + text + sql.slice(caret)
    setSql(next)
    setBuilder(null)
    const at = start + text.length
    setCaret(at)
    requestAnimationFrame(() => {
      editor.current?.focus()
      editor.current?.setSelectionRange(at, at)
    })
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      void run()
    } else if (event.key === 'Tab' && suggestions.length) {
      event.preventDefault()
      insert(suggestions[0])
    } else if (event.key === 'Tab') {
      event.preventDefault()
      insert('  ', '')
    }
  }

  // --- Saved queries ---

  const open = (item: ReportItem) => {
    const query = item.definition.query
    setOpenId(item.id)
    setSql(query?.sql || '')
    setParams(query?.params || {})
    setView(query?.view || 'table')
    setBuilder(null)
    setResult(null)
    setError('')
    if (query?.sql && !queryParams(query.sql).some(name => !(query.params || {})[name]))
      void run(query.sql, query.params || {})
  }
  const startNew = () => {
    setOpenId('')
    setSql(START_SQL)
    setParams({})
    setView('table')
    setBuilder(null)
    setResult(null)
    setError('')
  }
  const current = (): SavedQuery => ({
    sql,
    view,
    params: Object.fromEntries(names.map(name => [name, params[name] ?? ''])),
  })
  const saveOpened = async () => {
    if (!opened) return
    const saved = await update(opened, {
      definition: { ...opened.definition, query: current() },
      revision: opened.revision,
    })
    if (saved) setNotice(`Saved “${saved.name}”.`)
  }

  const term = search.trim().toLowerCase()
  const tables = explorer.catalog.filter(
    table => !term || table.name.includes(term) || table.columns.some(column => column.name.includes(term)),
  )
  const mine = queries.filter(item => !item.shared)
  const shared = queries.filter(item => item.shared)
  const queryLink = (item: ReportItem): ReactNode => (
    <div key={item.id} className={`dx-saved${item.id === openId ? ' on' : ''}`}>
      <button type="button" onClick={() => open(item)} title={item.description || item.name}>
        {item.shared ? <LayoutTemplate size={13} /> : <Lock size={12} className="crp-faint" />}
        <span>{item.name}</span>
      </button>
      {item.canEdit && (
        <button
          type="button"
          className="crp-icon small"
          aria-label={`Delete ${item.name}`}
          onClick={async () => {
            if (!window.confirm(`Delete the query “${item.name}”? Reports that use it keep their own copy.`)) return
            await remove(item)
            if (item.id === openId) setOpenId('')
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )

  return (
    <section className="crp-page dx-page">
      <aside className="crp-side dx-side" aria-label="Tables and saved queries">
        {switcher}
        <label className="crp-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Find a table or column"
            aria-label="Find a table or column"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <p className="crp-tree-label">Tables</p>
        <div className="dx-tables">
          {tables.map(table => {
            const isOpen = expanded.includes(table.name) || Boolean(term)
            return (
              <div key={table.name} className="dx-table">
                <div className="dx-table-head">
                  <button
                    type="button"
                    className="dx-toggle"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} the columns of ${table.name}`}
                    onClick={() =>
                      setExpanded(list =>
                        list.includes(table.name) ? list.filter(name => name !== table.name) : [...list, table.name],
                      )
                    }
                  >
                    {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button
                    type="button"
                    className="dx-name"
                    title={`${table.about} Click to put the name in the query.`}
                    onClick={() => insert(table.name, '')}
                  >
                    <Table2 size={13} /> {table.name}
                  </button>
                </div>
                {isOpen && (
                  <div className="dx-columns">
                    {table.columns
                      .filter(column => !term || table.name.includes(term) || column.name.includes(term))
                      .map(column => (
                        <button
                          type="button"
                          key={column.name}
                          title={`${column.type}. Click to put it in the query.`}
                          onClick={() => insert(column.name, '')}
                        >
                          <span>{column.name}</span>
                          <em>{column.type}</em>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
          {!explorer.trackersLoaded && (
            <button type="button" className="crp-link dx-more" onClick={() => void explorer.loadTrackers()}>
              Show tracker tables
            </button>
          )}
        </div>
        <p className="crp-tree-label">Templates</p>
        {shared.length ? shared.map(queryLink) : <p className="crp-faint crp-small">None yet.</p>}
        <p className="crp-tree-label">Your queries</p>
        {mine.length ? mine.map(queryLink) : <p className="crp-faint crp-small">None yet.</p>}
      </aside>

      <div className="crp-main dx-main">
        {problem && (
          <Notice kind="error" onClose={onDismissProblem}>
            {problem}
          </Notice>
        )}
        {notice && (
          <Notice kind="info" onClose={() => setNotice('')}>
            {notice}
          </Notice>
        )}
        <header className="crp-head">
          <div className="crp-title">
            <h2>{opened ? opened.name : 'New query'}</h2>
            <p>
              {opened
                ? opened.shared
                  ? 'Template for everyone with Data explorer'
                  : 'Your saved query'
                : 'Read-only. Runs in your browser on data you can already see.'}
            </p>
          </div>
          <div className="crp-head-actions">
            <button type="button" className="crp-btn" onClick={startNew}>
              <Plus size={14} /> New query
            </button>
            {opened?.canEdit && (
              <button type="button" className="crp-btn" disabled={busy} onClick={() => void saveOpened()}>
                <Save size={14} /> Save
              </button>
            )}
            {canChange && (
              <button type="button" className="crp-btn" disabled={busy} onClick={() => setDialog('save')}>
                <LayoutTemplate size={14} /> {opened ? 'Save as new' : 'Save query'}
              </button>
            )}
          </div>
        </header>

        <div className="dx-panel">
          <div className="dx-panel-head">
            <span>
              <Wand2 size={14} /> Builder
            </span>
            {builder ? (
              <button type="button" className="crp-link" onClick={() => setBuilder(null)}>
                Close the builder
              </button>
            ) : (
              <button type="button" className="crp-link" onClick={() => applyBuilder(emptyBuilder())}>
                Build a query without SQL
              </button>
            )}
          </div>
          {builder && (
            <div className="dx-builder">
              <label>
                <span>From</span>
                <select value={builder.table} onChange={event => applyBuilder(emptyBuilder(event.target.value))}>
                  {explorer.catalog.map(table => (
                    <option key={table.name} value={table.name}>
                      {table.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>With</span>
                <select value={builder.join} onChange={event => applyBuilder({ ...builder, join: event.target.value })}>
                  <option value="">Nothing else</option>
                  {joinsFrom(builder.table).map(join => (
                    <option key={join.key} value={join.key}>
                      {join.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Show</span>
                <select
                  value={builder.summary}
                  onChange={event => {
                    const summary = event.target.value as BuilderSummary
                    const needs = SUMMARIES.find(item => item.value === summary)?.measure
                    const numeric = columns.find(column => column.type === 'number')?.key || ''
                    applyBuilder({
                      ...builder,
                      summary,
                      measure: needs ? (summary === 'count_distinct' ? columns[0]?.key || '' : numeric) : '',
                    })
                  }}
                >
                  {SUMMARIES.map(item => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {SUMMARIES.find(item => item.value === builder.summary)?.measure && (
                <label>
                  <span>Of</span>
                  <select
                    value={builder.measure}
                    onChange={event => applyBuilder({ ...builder, measure: event.target.value })}
                  >
                    {columns
                      .filter(
                        column => builder.summary === 'count_distinct' || ['number', 'date'].includes(column.type),
                      )
                      .map(column => (
                        <option key={column.key} value={column.key}>
                          {column.key}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {builder.summary === 'rows' ? (
                <label className="dx-wide">
                  <span>Columns</span>
                  <select
                    value=""
                    onChange={event =>
                      event.target.value &&
                      applyBuilder({ ...builder, columns: [...builder.columns, event.target.value] })
                    }
                  >
                    <option value="">
                      {builder.columns.length ? 'Add a column…' : 'All columns (add to choose)…'}
                    </option>
                    {columns
                      .filter(column => !builder.columns.includes(column.key))
                      .map(column => (
                        <option key={column.key} value={column.key}>
                          {column.key}
                        </option>
                      ))}
                  </select>
                  <div className="crp-choices">
                    {builder.columns.map(key => (
                      <button
                        type="button"
                        key={key}
                        className="on"
                        onClick={() =>
                          applyBuilder({ ...builder, columns: builder.columns.filter(item => item !== key) })
                        }
                      >
                        {key} <X size={11} />
                      </button>
                    ))}
                  </div>
                </label>
              ) : (
                <label>
                  <span>Grouped by</span>
                  <select
                    value={builder.groupBy[0] || ''}
                    onChange={event =>
                      applyBuilder({
                        ...builder,
                        groupBy: event.target.value ? [event.target.value, ...builder.groupBy.slice(1)] : [],
                      })
                    }
                  >
                    <option value="">Nothing (one total)</option>
                    {columns.map(column => (
                      <option key={column.key} value={column.key}>
                        {column.key}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {builder.summary !== 'rows' && builder.groupBy[0] && (
                <label>
                  <span>Then by</span>
                  <select
                    value={builder.groupBy[1] || ''}
                    onChange={event =>
                      applyBuilder({
                        ...builder,
                        groupBy: [builder.groupBy[0], ...(event.target.value ? [event.target.value] : [])],
                      })
                    }
                  >
                    <option value="">Nothing</option>
                    {columns
                      .filter(column => column.key !== builder.groupBy[0])
                      .map(column => (
                        <option key={column.key} value={column.key}>
                          {column.key}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {builder.summary !== 'rows' &&
                builder.groupBy.some(key => columns.find(column => column.key === key)?.type === 'date') && (
                  <label>
                    <span>Dates</span>
                    <select
                      value={builder.bucket}
                      onChange={event => applyBuilder({ ...builder, bucket: event.target.value as Builder['bucket'] })}
                    >
                      <option value="day">As they are</option>
                      <option value="week">By week</option>
                      <option value="month">By month</option>
                    </select>
                  </label>
                )}
              {builder.summary !== 'rows' && (
                <label>
                  <span>Order</span>
                  <select
                    value={builder.sort}
                    onChange={event => applyBuilder({ ...builder, sort: event.target.value as Builder['sort'] })}
                  >
                    <option value="value_desc">Largest first</option>
                    <option value="value_asc">Smallest first</option>
                    <option value="group">By group</option>
                    <option value="none">As they come</option>
                  </select>
                </label>
              )}
              <label>
                <span>At most</span>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={builder.limit}
                  onChange={event => applyBuilder({ ...builder, limit: Number(event.target.value) || 100 })}
                />
              </label>
              <div className="dx-filters">
                {builder.filters.map((filter, index) => {
                  const needsValue = FILTER_OPS.find(item => item.value === filter.op)?.needsValue
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: filters have no id of their own
                    <div key={index} className="dx-filter">
                      <span>{index ? 'and' : 'Only where'}</span>
                      <select
                        value={filter.column}
                        onChange={event => setFilter(index, { column: event.target.value })}
                      >
                        {columns.map(column => (
                          <option key={column.key} value={column.key}>
                            {column.key}
                          </option>
                        ))}
                      </select>
                      <select
                        value={filter.op}
                        onChange={event => setFilter(index, { op: event.target.value as BuilderFilterOp })}
                      >
                        {FILTER_OPS.map(item => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      {needsValue && !filter.ask && (
                        <input
                          value={filter.value}
                          placeholder="Value"
                          onChange={event => setFilter(index, { value: event.target.value })}
                        />
                      )}
                      {needsValue && (
                        <label className="crp-check">
                          <input
                            type="checkbox"
                            checked={filter.ask}
                            onChange={event => setFilter(index, { ask: event.target.checked })}
                          />
                          Ask each time
                        </label>
                      )}
                      <button
                        type="button"
                        className="crp-icon small"
                        aria-label="Remove this condition"
                        onClick={() =>
                          applyBuilder({ ...builder, filters: builder.filters.filter((_, at) => at !== index) })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  className="crp-btn subtle"
                  onClick={() =>
                    applyBuilder({
                      ...builder,
                      filters: [
                        ...builder.filters,
                        {
                          column: (columns.find(column => !/(^|_)id$/.test(column.name)) || columns[0])?.key || '',
                          op: 'is',
                          value: '',
                          ask: false,
                        },
                      ],
                    })
                  }
                >
                  <Plus size={13} /> Add a condition
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="dx-panel dx-editor">
          <textarea
            ref={editor}
            className="dx-sql"
            value={sql}
            spellCheck={false}
            aria-label="SQL query"
            rows={Math.min(16, Math.max(6, sql.split('\n').length + 1))}
            onChange={event => {
              setSql(event.target.value)
              setCaret(event.target.selectionStart)
              if (builder) setBuilder(null)
            }}
            onKeyDown={keys}
            onKeyUp={event => setCaret(event.currentTarget.selectionStart)}
            onClick={event => setCaret(event.currentTarget.selectionStart)}
          />
          {suggestions.length > 0 && (
            <div className="dx-suggest" role="listbox" aria-label="Suggestions">
              <span>Tab to use</span>
              {suggestions.map(item => (
                <button type="button" key={item} role="option" aria-selected={false} onClick={() => insert(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}
          <div className="dx-run">
            {names.map(name => (
              <ParamInput
                key={name}
                name={name}
                value={params[name] ?? ''}
                clients={clients}
                projects={projects}
                accounts={accounts}
                tableNames={explorer.catalog.map(table => table.name)}
                isTableIdentifier={identifierParams.includes(name)}
                onChange={value => setParams(current => ({ ...current, [name]: value }))}
              />
            ))}
            <span className="crp-spacer" />
            <button type="button" className="crp-btn primary" disabled={running} onClick={() => void run()}>
              <Play size={14} /> {running ? 'Running…' : 'Run'} <kbd>Ctrl+Enter</kbd>
            </button>
          </div>
        </div>

        <div className="dx-panel dx-results">
          <div className="dx-panel-head">
            <span role="status">
              {error
                ? 'The query did not run'
                : result
                  ? `${result.rows.length}${result.truncated ? '+' : ''} row${result.rows.length === 1 ? '' : 's'} · ${result.ms} ms · ran in your browser`
                  : 'Run the query to see its result.'}
            </span>
            <div className="dx-views" role="group" aria-label="Show the result as">
              {QUERY_VIEWS.map(item => (
                <button
                  type="button"
                  key={item}
                  className={view === item ? 'on' : ''}
                  aria-pressed={view === item}
                  onClick={() => setView(item)}
                >
                  {VIEW_LABELS[item]}
                </button>
              ))}
              <button
                type="button"
                className="crp-icon small"
                aria-label="Download as CSV"
                title="Download as CSV"
                disabled={!result}
                onClick={() => result && downloadCsv(opened?.name || 'query', resultCsv(result))}
              >
                <Download size={13} />
              </button>
            </div>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {result && (
            <div className={`dx-result dx-result-${view}`}>
              <QueryResultView result={result} view={view} today={explorer.today} />
            </div>
          )}
          {result && canChange && (
            <div className="dx-result-actions">
              <button type="button" className="crp-btn" onClick={() => setDialog('add')}>
                <FilePlus2 size={14} /> Add to a report
              </button>
            </div>
          )}
        </div>
        <p className="crp-muted dx-help">
          <Database size={13} /> Read-only SQL: SELECT with JOIN / LEFT JOIN, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT;
          COUNT, SUM, AVG, MIN, MAX, CASE, LIKE, IN, BETWEEN, IS NULL; dates with WEEK_START(), MONTH_START(),
          DAYS_BETWEEN(), DATE_ADD(), CURRENT_DATE. Text comparisons ignore case. Write {'{{name}}'} to ask for a value
          each time.
        </p>
      </div>

      {dialog === 'save' && (
        <SaveQueryDialog
          isAdmin={isAdmin}
          busy={busy}
          initialName={opened ? `${opened.name} (copy)` : ''}
          onClose={() => setDialog(null)}
          onSave={async (name, description, shared) => {
            const made = await create({
              kind: 'query',
              name,
              description,
              shared,
              definition: { widgets: [], filters: { range: 'all' }, query: current() },
            })
            if (!made) return
            setDialog(null)
            setOpenId(made.id)
            setNotice(
              shared ? `“${made.name}” is now a template for everyone with Data explorer.` : `Saved “${made.name}”.`,
            )
          }}
        />
      )}
      {dialog === 'add' && (
        <AddToReportDialog
          reports={reports}
          busy={busy}
          initialTitle={opened?.name || ''}
          onClose={() => setDialog(null)}
          onAdd={async (target, title, newName) => {
            const query = paramsForReport(current())
            if (target) {
              const report = reports.find(item => item.id === target)
              if (!report) return
              const size = WIDGET_SIZES.query
              const spot = freeSpot(report.definition.widgets, size.w, size.h)
              const widget = { ...newWidget('query', spot), title, query }
              const saved = await update(report, {
                definition: { ...report.definition, widgets: [...report.definition.widgets, widget] },
                revision: report.revision,
              })
              if (!saved) return
              setDialog(null)
              openReport(saved.id)
            } else {
              const widget = { ...newWidget('query', { x: 0, y: 0 }), title, query, w: 12, h: 9 }
              const made = await create({
                kind: 'report',
                name: newName || title || 'Query report',
                definition: { widgets: [widget], filters: { range: 'all' } },
              })
              if (!made) return
              setDialog(null)
              openReport(made.id)
            }
          }}
        />
      )}
    </section>
  )
}

/** A {{parameter}}'s box: table identifiers and common filters get validated dropdowns. */
export function ParamInput({
  name,
  value,
  clients,
  projects,
  accounts,
  tableNames = [],
  isTableIdentifier = false,
  onChange,
}: {
  name: string
  value: string
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  tableNames?: string[]
  isTableIdentifier?: boolean
  onChange: (value: string) => void
}) {
  let choices: { value: string; label: string }[] | null = null
  // {{client}} takes the name, {{client_id}} the id: both are picked by name.
  const pick = (list: { id: string; name: string }[], byId: boolean) =>
    list.map(item => ({ value: byId ? item.id : item.name, label: item.name }))
  const person = /^(user|assignee|person|owner)(_name|_id)?$/.exec(name)
  if (isTableIdentifier) choices = tableNames.map(table => ({ value: table, label: table }))
  else if (/^client(_name|_id)?$/.test(name))
    choices = pick(clients.filter(client => !client.archived), name.endsWith('_id'))
  else if (/^project(_name|_id)?$/.test(name))
    choices = pick(projects.filter(project => !project.archived), name.endsWith('_id'))
  else if (person)
    choices = pick(
      accounts.filter(account => account.status === 'Active'),
      person[2] === '_id',
    )
  const isDate = /(^|_)(date|from|to|start|end|since|until|day|week|month)($|_)/.test(name)
  return (
    <label className="dx-param">
      <span>{name}</span>
      {choices ? (
        <select value={value} onChange={event => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {choices.map(choice => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <input type={isDate ? 'date' : 'text'} value={value} onChange={event => onChange(event.target.value)} />
      )}
    </label>
  )
}

function SaveQueryDialog({
  isAdmin,
  busy,
  initialName,
  onClose,
  onSave,
}: {
  isAdmin: boolean
  busy: boolean
  initialName: string
  onClose: () => void
  onSave: (name: string, description: string, shared: boolean) => void
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [shared, setShared] = useState(false)
  return (
    <Dialog title="Save query" onClose={onClose} busy={busy}>
      <form
        className="crp-dialog-body"
        onSubmit={event => {
          event.preventDefault()
          if (name.trim()) onSave(name.trim(), description.trim(), isAdmin && shared)
        }}
      >
        <label className="crp-form-row">
          <span>Name</span>
          <input value={name} maxLength={120} required onChange={event => setName(event.target.value)} />
        </label>
        <label className="crp-form-row">
          <span>What it shows</span>
          <textarea
            rows={3}
            maxLength={500}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {isAdmin ? (
          <label className="crp-check">
            <input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />
            Save as a template for everyone with Data explorer
          </label>
        ) : (
          <p className="crp-muted">Only you see this query. An Administrator can make templates for everyone.</p>
        )}
        <p className="crp-muted">
          The query is saved with its {'{{parameters}}'} and their current values, which are filled in when it opens.
        </p>
        <div className="k-dialog-actions">
          <span className="crp-spacer" />
          <button type="button" className="crp-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="crp-btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function AddToReportDialog({
  reports,
  busy,
  initialTitle,
  onClose,
  onAdd,
}: {
  reports: ReportItem[]
  busy: boolean
  initialTitle: string
  onClose: () => void
  onAdd: (reportId: string, title: string, newName: string) => void
}) {
  const [target, setTarget] = useState(reports[0]?.id || '')
  const [title, setTitle] = useState(initialTitle)
  const [newName, setNewName] = useState('')
  return (
    <Dialog title="Add to a report" onClose={onClose} busy={busy}>
      <form
        className="crp-dialog-body"
        onSubmit={event => {
          event.preventDefault()
          onAdd(target, title.trim(), newName.trim())
        }}
      >
        <label className="crp-form-row">
          <span>Report</span>
          <select value={target} onChange={event => setTarget(event.target.value)}>
            {reports.map(report => (
              <option key={report.id} value={report.id}>
                {report.name}
              </option>
            ))}
            <option value="">A new report…</option>
          </select>
        </label>
        {!target && (
          <label className="crp-form-row">
            <span>New report name</span>
            <input value={newName} maxLength={120} onChange={event => setNewName(event.target.value)} />
          </label>
        )}
        <label className="crp-form-row">
          <span>Widget title</span>
          <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} />
        </label>
        <p className="crp-muted">
          The report keeps its own copy of the query and runs it each time it opens, with fresh data. Client, project,
          person and date parameters follow the report’s filters; other parameters keep the values you chose. Change
          them in the widget’s settings.
        </p>
        <div className="k-dialog-actions">
          <span className="crp-spacer" />
          <button type="button" className="crp-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="crp-btn primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
