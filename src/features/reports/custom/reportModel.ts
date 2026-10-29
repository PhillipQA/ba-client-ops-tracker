// Custom reports: dashboards people build themselves from widgets (number tiles, charts, tables, timelines), kept in
// folders, private or shared. This module is shared by the browser and the server, so it stays free of React and Node.

export const GRID_COLUMNS = 12
export const REPORT_LIMITS = {
  name: 120,
  description: 500,
  widgets: 60,
  filters: 10,
  title: 120,
  text: 4000,
  columns: 20,
  values: 50,
  items: 400,
  rows: 500,
  definitionBytes: 1_000_000,
  tableColumns: 20,
  tableRows: 300,
  cell: 1000,
  choices: 30,
} as const

export type SourceId = 'tasks' | 'time' | 'activities' | 'events' | 'tracker' | 'table'
export const SOURCE_IDS: SourceId[] = ['tasks', 'time', 'activities', 'events', 'tracker', 'table']

export type WidgetKind =
  | 'datatable'
  | 'metric'
  | 'bar'
  | 'column'
  | 'line'
  | 'pie'
  | 'table'
  | 'gantt'
  | 'heading'
  | 'note'
export const WIDGET_KINDS: WidgetKind[] = [
  'datatable',
  'metric',
  'bar',
  'column',
  'line',
  'pie',
  'table',
  'gantt',
  'heading',
  'note',
]

export type MeasureOp = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct' | 'percent'
export const MEASURE_OPS: MeasureOp[] = ['count', 'sum', 'avg', 'min', 'max', 'distinct', 'percent']

export type FilterOp =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'empty'
  | 'not_empty'
  | 'eq'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after'
  | 'on'
  | 'true'
  | 'false'
export const FILTER_OPS: FilterOp[] = [
  'is',
  'is_not',
  'contains',
  'empty',
  'not_empty',
  'eq',
  'gt',
  'lt',
  'before',
  'after',
  'on',
  'true',
  'false',
]

export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year'
export const BUCKETS: Bucket[] = ['day', 'week', 'month', 'quarter', 'year']

export type RangePreset =
  | 'all'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'last_30'
  | 'last_90'
  | 'this_quarter'
  | 'this_year'
  | 'custom'
export const RANGE_PRESETS: RangePreset[] = [
  'all',
  'this_week',
  'this_month',
  'last_month',
  'last_30',
  'last_90',
  'this_quarter',
  'this_year',
  'custom',
]

export type GroupSort = 'value_desc' | 'value_asc' | 'label'

export type WidgetFilter = { field: string; op: FilterOp; value?: string; values?: string[] }
export type Measure = { op: MeasureOp; field?: string; where?: WidgetFilter }

export type Widget = {
  id: string
  kind: WidgetKind
  title: string
  /** Place on the 12-column grid, in grid cells. */
  x: number
  y: number
  w: number
  h: number
  source: SourceId
  /** Tracker rows: which tracker. */
  trackerId?: string
  /** The date the report's date range applies to. Empty: the range does not apply. */
  dateField?: string
  filters: WidgetFilter[]
  measure: Measure
  /** Charts and summary tables: one bar, slice or row per value of this field. */
  groupBy?: string
  /** When grouping by a date: by day, week, month… */
  bucket?: Bucket
  /** Column and line charts: one series per value of this field. Gantt: the bar colour. */
  splitBy?: string
  sort?: GroupSort
  /** At most this many groups (the rest are added up as Other) or table rows. */
  limit?: number
  /** Tables that list rows: the columns shown, and their order. */
  columns?: string[]
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  /** Gantt: the bar's name, start and end. */
  label?: string
  start?: string
  end?: string
  /** Headings and notes. */
  text?: string
  /** Fill-in tables: the columns and rows people type into the report. */
  table?: DataTable
  /** Widgets that read a fill-in table of this report: which one. */
  tableId?: string
}

/** Colours a choice can have. They are the same in tables, charts and timelines. */
export type DataColor = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet'
export const DATA_COLORS: DataColor[] = ['gray', 'blue', 'green', 'amber', 'red', 'violet']
export type DataColumnType = 'text' | 'number' | 'date' | 'choice'
export const DATA_COLUMN_TYPES: DataColumnType[] = ['text', 'number', 'date', 'choice']
export type DataChoice = { label: string; color: DataColor }
export type DataColumn = { id: string; name: string; type: DataColumnType; options?: DataChoice[] }
/** Cells are kept as typed: a date column keeps "TBA" as it is, and a real date as YYYY-MM-DD. */
export type DataRow = { id: string; cells: Record<string, string> }
export type DataTable = { columns: DataColumn[]; rows: DataRow[] }

export type ReportFilters = {
  range: RangePreset
  from?: string
  to?: string
  clientId?: string
  projectId?: string
  userId?: string
}
export type ReportDefinition = {
  widgets: Widget[]
  filters: ReportFilters
  /** The week this report is for (its update date), when it is kept week by week. */
  week?: string
  /** Reports of the same weekly series share this. */
  series?: string
  /** A past week: kept as the record, and not changed. */
  locked?: boolean
}

export type ItemKind = 'report' | 'folder' | 'template'
export type ReportItem = {
  id: string
  kind: ItemKind
  name: string
  description: string
  /** The folder it sits in. Empty: not in a folder. */
  folderId: string
  shared: boolean
  position: number
  definition: ReportDefinition
  revision: number
  createdBy: string
  createdByName: string
  updatedByName: string
  createdAt: string
  updatedAt: string
  canEdit: boolean
  /** Templates: which suggested template this account's copy replaces. Empty for templates people made. */
  templateKey: string
  /** Templates: hidden from everyone but Administrators. */
  hidden: boolean
  /** A suggested template nobody has changed yet. It is not stored; changing it stores the account's own copy. */
  builtIn?: boolean
}

/** A sensible size for each kind of widget, in grid cells. */
export const WIDGET_SIZES: Record<WidgetKind, { w: number; h: number }> = {
  datatable: { w: 12, h: 7 },
  metric: { w: 3, h: 3 },
  bar: { w: 6, h: 8 },
  column: { w: 6, h: 8 },
  line: { w: 6, h: 8 },
  pie: { w: 4, h: 8 },
  table: { w: 6, h: 8 },
  gantt: { w: 12, h: 9 },
  heading: { w: 12, h: 2 },
  note: { w: 4, h: 3 },
}
export const MIN_SIZE: Record<WidgetKind, { w: number; h: number }> = {
  datatable: { w: 3, h: 3 },
  metric: { w: 2, h: 2 },
  bar: { w: 3, h: 4 },
  column: { w: 3, h: 4 },
  line: { w: 3, h: 4 },
  pie: { w: 3, h: 4 },
  table: { w: 3, h: 4 },
  gantt: { w: 4, h: 4 },
  heading: { w: 2, h: 1 },
  note: { w: 2, h: 2 },
}
export const MAX_ROWS = 400

export const emptyDefinition = (): ReportDefinition => ({ widgets: [], filters: { range: 'all' } })

// --- Cleaning (the server runs this on everything it stores) ---

const DATE = /^\d{4}-\d{2}-\d{2}$/
const KEY = /^[A-Za-z0-9_:.$-]{1,80}$/

const text = (value: unknown, max: number, multiline = false) => {
  if (typeof value !== 'string') return ''
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
  const out = multiline ? cleaned.replace(/\s+$/, '') : cleaned.replace(/\s+/g, ' ').trim()
  return out.slice(0, max)
}
const key = (value: unknown) => (typeof value === 'string' && KEY.test(value) ? value : '')
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback
const int = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}
const date = (value: unknown) => (typeof value === 'string' && DATE.test(value) ? value : '')

export function cleanFilter(raw: unknown): WidgetFilter | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const field = key(input.field)
  if (!field) return null
  const filter: WidgetFilter = { field, op: pick(input.op, FILTER_OPS, 'is') }
  const value = text(input.value, 200)
  if (value) filter.value = value
  if (Array.isArray(input.values)) {
    const values = input.values
      .map(item => text(item, 200))
      .filter(Boolean)
      .slice(0, REPORT_LIMITS.values)
    if (values.length) filter.values = [...new Set(values)]
  }
  return filter
}

export function cleanWidget(raw: unknown): Widget | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const kind = pick(input.kind, WIDGET_KINDS, 'metric')
  if (!WIDGET_KINDS.includes(input.kind as WidgetKind)) return null
  const min = MIN_SIZE[kind]
  const w = int(input.w, min.w, GRID_COLUMNS, WIDGET_SIZES[kind].w)
  const measureIn = (input.measure && typeof input.measure === 'object' ? input.measure : {}) as Record<string, unknown>
  const measure: Measure = { op: pick(measureIn.op, MEASURE_OPS, 'count') }
  const measureField = key(measureIn.field)
  if (measureField) measure.field = measureField
  const where = cleanFilter(measureIn.where)
  if (where) measure.where = where
  const widget: Widget = {
    id: key(input.id) || newId(),
    kind,
    title: text(input.title, REPORT_LIMITS.title),
    x: int(input.x, 0, GRID_COLUMNS - w, 0),
    y: int(input.y, 0, MAX_ROWS, 0),
    w,
    h: int(input.h, min.h, 40, WIDGET_SIZES[kind].h),
    source: pick(input.source, SOURCE_IDS, 'tasks'),
    filters: (Array.isArray(input.filters) ? input.filters : [])
      .map(cleanFilter)
      .filter((item): item is WidgetFilter => Boolean(item))
      .slice(0, REPORT_LIMITS.filters),
    measure,
  }
  const optional: (keyof Widget)[] = [
    'trackerId',
    'dateField',
    'groupBy',
    'splitBy',
    'orderBy',
    'label',
    'start',
    'end',
    'tableId',
  ]
  for (const name of optional) {
    const value = key(input[name])
    if (value) (widget as Record<string, unknown>)[name] = value
  }
  if (input.bucket !== undefined && BUCKETS.includes(input.bucket as Bucket)) widget.bucket = input.bucket as Bucket
  if (input.sort !== undefined)
    widget.sort = pick(input.sort, ['value_desc', 'value_asc', 'label'] as const, 'value_desc')
  if (input.limit !== undefined) widget.limit = int(input.limit, 1, REPORT_LIMITS.rows, 10)
  if (input.orderDir === 'asc' || input.orderDir === 'desc') widget.orderDir = input.orderDir
  if (Array.isArray(input.columns)) {
    const columns = input.columns.map(key).filter(Boolean).slice(0, REPORT_LIMITS.columns)
    if (columns.length) widget.columns = [...new Set(columns)]
  }
  const body = text(input.text, REPORT_LIMITS.text, kind === 'note')
  if (body) widget.text = body
  if (kind === 'datatable') widget.table = cleanTable(input.table)
  return widget
}

export function cleanTable(raw: unknown): DataTable {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const seen = new Set<string>()
  const columns: DataColumn[] = []
  for (const item of Array.isArray(input.columns) ? input.columns : []) {
    if (!item || typeof item !== 'object' || columns.length >= REPORT_LIMITS.tableColumns) continue
    const column = item as Record<string, unknown>
    const id = key(column.id) || newId()
    if (seen.has(id)) continue
    seen.add(id)
    const type = pick(column.type, DATA_COLUMN_TYPES, 'text')
    const out: DataColumn = { id, name: text(column.name, 80) || 'Column', type }
    if (type === 'choice') {
      const labels = new Set<string>()
      out.options = (Array.isArray(column.options) ? column.options : [])
        .map(option => {
          const value = (option && typeof option === 'object' ? option : {}) as Record<string, unknown>
          return { label: text(value.label, 80), color: pick(value.color, DATA_COLORS, 'gray') }
        })
        .filter(
          option => option.label && !labels.has(option.label.toLowerCase()) && labels.add(option.label.toLowerCase()),
        )
        .slice(0, REPORT_LIMITS.choices)
    }
    columns.push(out)
  }
  const ids = new Set(columns.map(column => column.id))
  const rowIds = new Set<string>()
  const rows: DataRow[] = []
  for (const item of Array.isArray(input.rows) ? input.rows : []) {
    if (!item || typeof item !== 'object' || rows.length >= REPORT_LIMITS.tableRows) continue
    const row = item as Record<string, unknown>
    const id = key(row.id) || newId()
    if (rowIds.has(id)) continue
    rowIds.add(id)
    const cells: Record<string, string> = {}
    const given = (row.cells && typeof row.cells === 'object' ? row.cells : {}) as Record<string, unknown>
    for (const [column, value] of Object.entries(given)) {
      if (!ids.has(column)) continue
      const cell = text(typeof value === 'number' ? String(value) : value, REPORT_LIMITS.cell, true)
      if (cell) cells[column] = cell
    }
    rows.push({ id, cells })
  }
  return { columns, rows }
}

export function cleanReportFilters(raw: unknown): ReportFilters {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const filters: ReportFilters = { range: pick(input.range, RANGE_PRESETS, 'all') }
  if (filters.range === 'custom') {
    const from = date(input.from),
      to = date(input.to)
    if (from) filters.from = from
    if (to) filters.to = to
  }
  for (const name of ['clientId', 'projectId', 'userId'] as const) {
    const value = text(input[name], 100)
    if (value) filters[name] = value
  }
  return filters
}

/** Cleans a report's widgets and filters. Widgets that overlap are moved down so none hide another. */
export function cleanDefinition(raw: unknown): ReportDefinition {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const seen = new Set<string>()
  const widgets = (Array.isArray(input.widgets) ? input.widgets : [])
    .map(cleanWidget)
    .filter((widget): widget is Widget => {
      if (!widget || seen.has(widget.id)) return false
      seen.add(widget.id)
      return true
    })
    .slice(0, REPORT_LIMITS.widgets)
  const out: ReportDefinition = { widgets: settle(widgets), filters: cleanReportFilters(input.filters) }
  const week = date(input.week)
  if (week) out.week = week
  const series = key(input.series)
  if (series) out.series = series
  if (input.locked === true) out.locked = true
  return out
}

/** Where a widget's data comes from: its tracker or its table, by id. */
export const sourceRef = (widget: Pick<Widget, 'source' | 'trackerId' | 'tableId'>) =>
  widget.source === 'table' ? widget.tableId : widget.trackerId

/** A copy of a report's widgets with new ids, keeping charts pointed at their tables. */
export function reidentify(definition: ReportDefinition): ReportDefinition {
  const copy: ReportDefinition = JSON.parse(JSON.stringify(definition))
  const ids = new Map(copy.widgets.map(widget => [widget.id, newId()]))
  copy.widgets = copy.widgets.map(widget => ({
    ...widget,
    id: ids.get(widget.id) as string,
    ...(widget.tableId ? { tableId: ids.get(widget.tableId) || widget.tableId } : {}),
  }))
  return copy
}

/**
 * Fills details tables: in a fill-in table whose first column names a detail ("Client name", "Project"…), the next
 * column gets the value when it is still empty.
 */
export function fillDetails(definition: ReportDefinition, values: Record<string, string>): ReportDefinition {
  const wanted = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]))
  return {
    ...definition,
    widgets: definition.widgets.map(widget => {
      const table = widget.table
      if (widget.kind !== 'datatable' || !table || table.columns.length < 2) return widget
      const [label, value] = table.columns
      let changed = false
      const rows = table.rows.map(row => {
        const fill = wanted.get((row.cells[label.id] || '').trim().toLowerCase())
        if (!fill || row.cells[value.id]) return row
        changed = true
        return { ...row, cells: { ...row.cells, [value.id]: fill } }
      })
      return changed ? { ...widget, table: { ...table, rows } } : widget
    }),
  }
}

// --- Fill-in tables: typing and pasting ---

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A typed or pasted date as YYYY-MM-DD: 2025-11-04, Nov 4, 2025, 4 Nov 2025 or 11/4/2025 (month first). */
export function readDate(value: string): string | null {
  const textValue = value.trim()
  const valid = (year: number, month: number, day: number) => {
    const at = new Date(Date.UTC(year, month - 1, day))
    return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
      ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : null
  }
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(textValue)
  if (match) return valid(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(textValue)
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])
    return valid(year, Number(match[1]), Number(match[2]))
  }
  match = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(textValue)
  if (match) {
    const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1
    return month ? valid(Number(match[3]), month, Number(match[2])) : null
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(textValue)
  if (match) {
    const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase()) + 1
    return month ? valid(Number(match[3]), month, Number(match[1])) : null
  }
  return null
}

/**
 * What a typed value is kept as in a column: dates as YYYY-MM-DD (anything else, like "TBA", as typed), numbers
 * without thousands separators, and a choice spelled the way the column has it. A new choice is added to the column.
 */
export function enterCell(column: DataColumn, raw: string): { value: string; column: DataColumn } {
  const value = raw.replace(/\r\n?/g, '\n').trim().slice(0, REPORT_LIMITS.cell)
  if (!value) return { value: '', column }
  switch (column.type) {
    case 'date':
      return { value: readDate(value) || value, column }
    case 'number': {
      const number = Number(value.replace(/,/g, ''))
      return { value: Number.isFinite(number) && value.replace(/,/g, '') !== '' ? String(number) : value, column }
    }
    case 'choice': {
      const options = column.options || []
      const found = options.find(option => option.label.toLowerCase() === value.toLowerCase())
      if (found) return { value: found.label, column }
      if (options.length >= REPORT_LIMITS.choices) return { value, column }
      return { value, column: { ...column, options: [...options, { label: value.slice(0, 80), color: 'gray' }] } }
    }
    default:
      return { value, column }
  }
}

/** Rows and cells copied from Excel or Google Sheets (tab-separated, quotes around cells with line breaks). */
export function parseClipboard(textValue: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  const source = textValue.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"'
        index++
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell === '') quoted = true
    else if (char === '\t') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += char
  }
  row.push(cell)
  rows.push(row)
  return rows.slice(0, REPORT_LIMITS.tableRows)
}

/** Puts pasted cells into a table from a starting cell, adding rows (not columns) as needed. */
export function pasteInto(table: DataTable, startRow: number, startColumn: number, grid: string[][]): DataTable {
  const columns: DataColumn[] = table.columns.map(column => ({ ...column }))
  const rows = table.rows.map(row => ({ ...row, cells: { ...row.cells } }))
  grid.forEach((cells, offset) => {
    const at = startRow + offset
    if (at >= REPORT_LIMITS.tableRows) return
    while (rows.length <= at) rows.push({ id: newId(), cells: {} })
    cells.forEach((raw, step) => {
      const columnIndex = startColumn + step
      const column = columns[columnIndex]
      if (!column) return
      const entered = enterCell(column, raw)
      columns[columnIndex] = entered.column
      if (entered.value) rows[at].cells[column.id] = entered.value
      else delete rows[at].cells[column.id]
    })
  })
  return { columns, rows }
}

export function newId() {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

// --- The grid ---

export type Box = { x: number; y: number; w: number; h: number }
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const byPlace = (a: Box, b: Box) => a.y - b.y || a.x - b.x

/** Moves widgets down until none overlap, then lets every widget rise as far as it can, like items settling. */
export function settle<T extends Box>(widgets: T[], fixedIndex = -1): T[] {
  const placed: T[] = []
  const order = widgets.map((widget, index) => ({ widget, index })).sort((a, b) => byPlace(a.widget, b.widget))
  if (fixedIndex >= 0) {
    const at = order.findIndex(entry => entry.index === fixedIndex)
    order.unshift(...order.splice(at, 1))
  }
  const result = new Array<T>(widgets.length)
  for (const { widget, index } of order) {
    const box = { ...widget }
    box.x = Math.min(Math.max(0, box.x), GRID_COLUMNS - box.w)
    if (index !== fixedIndex) {
      // Rise as far as possible, then drop below anything still in the way.
      while (box.y > 0 && !placed.some(other => overlaps({ ...box, y: box.y - 1 }, other))) box.y -= 1
      for (let guard = 0; guard < MAX_ROWS; guard++) {
        const hit = placed.find(other => overlaps(box, other))
        if (!hit) break
        box.y = hit.y + hit.h
      }
    }
    placed.push(box)
    result[index] = box
  }
  return result
}

/** The layout with one widget moved or resized to a box; the others make room. */
export function placeWidget(widgets: Widget[], id: string, box: Box): Widget[] {
  const index = widgets.findIndex(widget => widget.id === id)
  if (index < 0) return widgets
  const min = MIN_SIZE[widgets[index].kind]
  const w = Math.min(GRID_COLUMNS, Math.max(min.w, box.w))
  const target = {
    ...widgets[index],
    w,
    h: Math.min(40, Math.max(min.h, box.h)),
    x: Math.min(GRID_COLUMNS - w, Math.max(0, box.x)),
    y: Math.min(MAX_ROWS, Math.max(0, box.y)),
  }
  const next = widgets.map((widget, at) => (at === index ? target : widget))
  return settle(next, index)
}

/** The first free place for a widget of this size, reading left to right, top to bottom. */
export function freeSpot(widgets: Box[], w: number, h: number): { x: number; y: number } {
  const bottom = widgets.reduce((max, widget) => Math.max(max, widget.y + widget.h), 0)
  for (let y = 0; y <= bottom; y++)
    for (let x = 0; x + w <= GRID_COLUMNS; x++)
      if (!widgets.some(other => overlaps({ x, y, w, h }, other))) return { x, y }
  return { x: 0, y: bottom }
}

// --- New widgets and ready-made reports ---

export const WIDGET_LABELS: Record<WidgetKind, string> = {
  datatable: 'Fill-in table',
  metric: 'Number tile',
  bar: 'Bar chart',
  column: 'Column chart',
  line: 'Line chart',
  pie: 'Pie chart',
  table: 'Table',
  gantt: 'Timeline (Gantt)',
  heading: 'Section heading',
  note: 'Note',
}

/** A new widget of a kind, with settings that show something straight away. */
export function newWidget(kind: WidgetKind, at: { x: number; y: number }, source: SourceId = 'tasks'): Widget {
  const size = WIDGET_SIZES[kind]
  const base: Widget = {
    id: newId(),
    kind,
    title: '',
    x: Math.min(at.x, GRID_COLUMNS - size.w),
    y: at.y,
    w: size.w,
    h: size.h,
    source,
    filters: [],
    measure: { op: 'count' },
  }
  const date = source === 'tasks' || source === 'tracker' ? undefined : 'date'
  if (date) base.dateField = date
  switch (kind) {
    case 'metric':
      return { ...base, title: 'Open tasks', filters: [{ field: 'done', op: 'false' }] }
    case 'bar':
      return { ...base, title: 'Open tasks by client', groupBy: 'client', filters: [{ field: 'done', op: 'false' }] }
    case 'column':
      return { ...base, title: 'Tasks raised per week', groupBy: 'dateRaised', bucket: 'week', sort: 'label' }
    case 'line':
      return {
        ...base,
        title: 'Tasks done per week',
        groupBy: 'resolvedDate',
        bucket: 'week',
        sort: 'label',
        filters: [{ field: 'done', op: 'true' }],
      }
    case 'pie':
      return { ...base, title: 'Tasks by state', groupBy: 'state', limit: 6 }
    case 'table':
      return {
        ...base,
        title: 'Overdue tasks',
        filters: [{ field: 'overdue', op: 'true' }],
        columns: ['title', 'client', 'assignee', 'dueDate', 'status'],
        orderBy: 'dueDate',
        orderDir: 'asc',
        limit: 50,
      }
    case 'gantt':
      return {
        ...base,
        title: 'Task timeline',
        label: 'title',
        start: 'startDate',
        end: 'dueDate',
        splitBy: 'state',
        filters: [{ field: 'startDate', op: 'not_empty' }],
        limit: 60,
      }
    case 'heading':
      return { ...base, title: '', text: 'Section' }
    case 'note':
      return { ...base, title: '', text: 'Write a note for whoever reads this report.' }
    case 'datatable':
      return {
        ...base,
        title: 'Table',
        dateField: undefined,
        table: {
          columns: [
            { id: newId(), name: 'Item', type: 'text' },
            {
              id: newId(),
              name: 'Status',
              type: 'choice',
              options: [
                { label: 'Not started', color: 'gray' },
                { label: 'In progress', color: 'blue' },
                { label: 'Done', color: 'green' },
              ],
            },
            { id: newId(), name: 'Due', type: 'date' },
            { id: newId(), name: 'Notes', type: 'text' },
          ],
          rows: [1, 2, 3].map(() => ({ id: newId(), cells: {} })),
        },
      }
  }
}

type Seed = Omit<Widget, 'id' | 'filters' | 'measure'> & Partial<Pick<Widget, 'filters' | 'measure'>>
const seed = (widgets: Seed[]): Widget[] =>
  settle(widgets.map(widget => ({ filters: [], measure: { op: 'count' }, ...widget, id: newId() }) as Widget))
const open: WidgetFilter = { field: 'done', op: 'false' }

/**
 * The suggested templates every account starts with. Administrators can change, hide or reset each one for their
 * account; the changed copy is stored with the template's key, and replaces this one.
 */
export type ReportTemplate = { id: string; name: string; about: string; build: () => ReportDefinition }
export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'rollout',
    name: 'Weekly roll-out status',
    about:
      'Type each week’s update into it: project details, KPI, a timeline by phase, schedule of activities, go-live schedule, risks and FSD/BRD.',
    build: () => rolloutReport(),
  },
  {
    id: 'team',
    name: 'Team workload',
    about: 'Open and overdue work per person, what got done each week, and what is late.',
    build: () => ({
      filters: { range: 'this_month' },
      widgets: seed([
        { kind: 'metric', title: 'Open tasks', x: 0, y: 0, w: 3, h: 3, source: 'tasks', filters: [open] },
        {
          kind: 'metric',
          title: 'Overdue',
          x: 3,
          y: 0,
          w: 3,
          h: 3,
          source: 'tasks',
          filters: [{ field: 'overdue', op: 'true' }],
        },
        {
          kind: 'metric',
          title: 'Done in this period',
          x: 6,
          y: 0,
          w: 3,
          h: 3,
          source: 'tasks',
          dateField: 'resolvedDate',
          filters: [{ field: 'done', op: 'true' }],
        },
        {
          kind: 'metric',
          title: 'Hours logged',
          x: 9,
          y: 0,
          w: 3,
          h: 3,
          source: 'time',
          dateField: 'date',
          measure: { op: 'sum', field: 'hours' },
        },
        {
          kind: 'bar',
          title: 'Open work by person',
          x: 0,
          y: 3,
          w: 6,
          h: 8,
          source: 'tasks',
          groupBy: 'assignee',
          filters: [open],
        },
        {
          kind: 'column',
          title: 'Done per week, by person',
          x: 6,
          y: 3,
          w: 6,
          h: 8,
          source: 'tasks',
          dateField: 'resolvedDate',
          groupBy: 'resolvedDate',
          bucket: 'week',
          splitBy: 'assignee',
          sort: 'label',
          filters: [{ field: 'done', op: 'true' }],
        },
        {
          kind: 'table',
          title: 'Overdue tasks',
          x: 0,
          y: 11,
          w: 12,
          h: 8,
          source: 'tasks',
          filters: [{ field: 'overdue', op: 'true' }],
          columns: ['title', 'kind', 'client', 'assignee', 'dueDate', 'status'],
          orderBy: 'dueDate',
          orderDir: 'asc',
          limit: 50,
        },
      ]),
    }),
  },
  {
    id: 'clients',
    name: 'Client status',
    about: 'Open work, turnaround and what each client is waiting on.',
    build: () => ({
      filters: { range: 'last_90' },
      widgets: seed([
        { kind: 'heading', title: '', text: 'Where things stand', x: 0, y: 0, w: 12, h: 2, source: 'tasks' },
        {
          kind: 'bar',
          title: 'Open tasks by client',
          x: 0,
          y: 2,
          w: 6,
          h: 8,
          source: 'tasks',
          groupBy: 'client',
          filters: [open],
        },
        {
          kind: 'pie',
          title: 'Waiting on',
          x: 6,
          y: 2,
          w: 6,
          h: 8,
          source: 'tasks',
          groupBy: 'waitingOn',
          filters: [open],
          limit: 6,
        },
        {
          kind: 'bar',
          title: 'Average turnaround by client (days)',
          x: 0,
          y: 10,
          w: 6,
          h: 8,
          source: 'tasks',
          dateField: 'resolvedDate',
          groupBy: 'client',
          measure: { op: 'avg', field: 'turnaroundDays' },
          filters: [{ field: 'turnaroundDays', op: 'not_empty' }],
        },
        {
          kind: 'table',
          title: 'Oldest open tasks',
          x: 6,
          y: 10,
          w: 6,
          h: 8,
          source: 'tasks',
          filters: [open],
          columns: ['title', 'client', 'ageDays', 'waitingOn'],
          orderBy: 'ageDays',
          orderDir: 'desc',
          limit: 20,
        },
      ]),
    }),
  },
  {
    id: 'effort',
    name: 'Time and effort',
    about: 'Hours logged by person, client and week, from the time logged on tasks.',
    build: () => ({
      filters: { range: 'this_month' },
      widgets: seed([
        {
          kind: 'metric',
          title: 'Hours logged',
          x: 0,
          y: 0,
          w: 4,
          h: 3,
          source: 'time',
          dateField: 'date',
          measure: { op: 'sum', field: 'hours' },
        },
        {
          kind: 'metric',
          title: 'People logging time',
          x: 4,
          y: 0,
          w: 4,
          h: 3,
          source: 'time',
          dateField: 'date',
          measure: { op: 'distinct', field: 'user' },
        },
        {
          kind: 'metric',
          title: 'Tasks worked on',
          x: 8,
          y: 0,
          w: 4,
          h: 3,
          source: 'time',
          dateField: 'date',
          measure: { op: 'distinct', field: 'task' },
        },
        {
          kind: 'column',
          title: 'Hours per week, by kind of work',
          x: 0,
          y: 3,
          w: 8,
          h: 8,
          source: 'time',
          dateField: 'date',
          groupBy: 'date',
          bucket: 'week',
          splitBy: 'category',
          sort: 'label',
          measure: { op: 'sum', field: 'hours' },
        },
        {
          kind: 'pie',
          title: 'Hours by client',
          x: 8,
          y: 3,
          w: 4,
          h: 8,
          source: 'time',
          dateField: 'date',
          groupBy: 'client',
          limit: 6,
          measure: { op: 'sum', field: 'hours' },
        },
        {
          kind: 'bar',
          title: 'Hours by person',
          x: 0,
          y: 11,
          w: 6,
          h: 8,
          source: 'time',
          dateField: 'date',
          groupBy: 'user',
          measure: { op: 'sum', field: 'hours' },
        },
        {
          kind: 'table',
          title: 'Time entries',
          x: 6,
          y: 11,
          w: 6,
          h: 8,
          source: 'time',
          dateField: 'date',
          columns: ['date', 'user', 'task', 'hours', 'category'],
          orderBy: 'date',
          orderDir: 'desc',
          limit: 100,
        },
      ]),
    }),
  },
  {
    id: 'timeline',
    name: 'Project timeline',
    about: 'Tasks and subtasks on a timeline, with progress and what is late.',
    build: () => ({
      filters: { range: 'all' },
      widgets: seed([
        {
          kind: 'metric',
          title: 'Subtasks done',
          x: 0,
          y: 0,
          w: 4,
          h: 3,
          source: 'tasks',
          filters: [{ field: 'kind', op: 'is', values: ['Subtask'] }],
          measure: { op: 'percent', where: { field: 'done', op: 'true' } },
        },
        {
          kind: 'metric',
          title: 'Late',
          x: 4,
          y: 0,
          w: 4,
          h: 3,
          source: 'tasks',
          filters: [{ field: 'overdue', op: 'true' }],
        },
        {
          kind: 'metric',
          title: 'Due in this period',
          x: 8,
          y: 0,
          w: 4,
          h: 3,
          source: 'tasks',
          dateField: 'dueDate',
        },
        {
          kind: 'gantt',
          title: 'Timeline',
          x: 0,
          y: 3,
          w: 12,
          h: 10,
          source: 'tasks',
          label: 'title',
          start: 'startDate',
          end: 'dueDate',
          splitBy: 'state',
          filters: [{ field: 'startDate', op: 'not_empty' }],
          limit: 80,
        },
      ]),
    }),
  },
]

// --- The weekly roll-out status: a report people type into, like the weekly status sheet ---

const choice = (label: string, color: DataColor): DataChoice => ({ label, color })
const column = (name: string, type: DataColumnType = 'text', options?: DataChoice[]): DataColumn => ({
  id: newId(),
  name,
  type,
  ...(options ? { options } : {}),
})
const filled = (columns: DataColumn[], values: string[][]): DataRow[] =>
  values.map(cells => ({
    id: newId(),
    cells: Object.fromEntries(cells.map((value, index) => [columns[index].id, value]).filter(([, value]) => value)),
  }))
const blankRows = (count: number): DataRow[] => Array.from({ length: count }, () => ({ id: newId(), cells: {} }))

export function rolloutReport(): ReportDefinition {
  const health = [choice('On track', 'green'), choice('At risk', 'amber'), choice('Delayed', 'red')]
  const details = [column('Detail'), column('Value')]
  const kpi = [
    column('KPI'),
    column('Status', 'choice', [
      choice('On time', 'green'),
      choice('In scope', 'green'),
      choice('At risk', 'amber'),
      choice('Off track', 'red'),
    ]),
    column('Notes'),
  ]
  const phases = [column('Phase'), column('Start', 'date'), column('End', 'date'), column('Health', 'choice', health)]
  const activities = [
    column('Activity'),
    column('Start', 'date'),
    column('End', 'date'),
    column('Person in-charge'),
    column('Status', 'choice', [
      choice('Not yet started', 'gray'),
      choice('In progress', 'blue'),
      choice('Pending', 'amber'),
      choice('Delayed', 'red'),
      choice('Completed', 'green'),
    ]),
  ]
  const goLive = [
    column('Location'),
    column('Mall sending', 'choice', [
      choice('Configured', 'green'),
      choice('Waiting for credentials', 'amber'),
      choice('Waiting for feedback', 'amber'),
      choice('No mall integ', 'gray'),
    ]),
    column('Target go live', 'date'),
    column('Status', 'choice', [
      choice('Completed', 'green'),
      choice('Scheduled', 'blue'),
      choice('For reset', 'amber'),
      choice('On hold', 'gray'),
    ]),
    column('Remarks'),
  ]
  const risks = [
    column('Description'),
    column('Risk / issue', 'choice', [choice('Risk', 'amber'), choice('Issue', 'red')]),
    column('Owner'),
    column('Due date', 'date'),
    column('Remarks'),
  ]
  const documents = [
    column('Title'),
    column('Submitted', 'date'),
    column('Status', 'choice', [
      choice('In review', 'blue'),
      choice('Waiting for signature', 'amber'),
      choice('Signed', 'green'),
      choice('Returned', 'red'),
    ]),
    column('Remarks'),
  ]
  const ids = { phases: newId(), goLive: newId() }
  const base = { filters: [] as WidgetFilter[], measure: { op: 'count' } as Measure, source: 'tasks' as SourceId }
  const table = (id: string, title: string, columns: DataColumn[], rows: DataRow[], box: Box): Widget => ({
    ...base,
    id,
    kind: 'datatable',
    title,
    ...box,
    table: { columns, rows },
  })
  const status = goLive[3].id
  const widgets: Widget[] = [
    { ...base, id: newId(), kind: 'heading', title: '', text: 'Project status update', x: 0, y: 0, w: 12, h: 2 },
    table(
      newId(),
      'Project details',
      details,
      filled(details, [
        ['Client name'],
        ['Project'],
        ['Software'],
        ['Project manager'],
        ['Business analyst'],
        ['Project ID'],
        ['Target go live'],
      ]),
      { x: 0, y: 2, w: 6, h: 9 },
    ),
    table(newId(), 'Project KPI', kpi, filled(kpi, [['Overall'], ['Scope'], ['Time / cost'], ['Schedule']]), {
      x: 6,
      y: 2,
      w: 6,
      h: 9,
    }),
    table(
      ids.phases,
      'Activity by month',
      phases,
      filled(
        phases,
        [
          'Kick off',
          'BPM',
          'Development & testing',
          'Data migration',
          'HW prep & BIR processing',
          'User acceptance testing',
          'Training',
          'Pre-live activities',
          'Go live (HO, pilot branch)',
          'Mass roll out',
          'Hypercare',
        ].map(name => [name]),
      ),
      { x: 0, y: 11, w: 5, h: 13 },
    ),
    {
      ...base,
      id: newId(),
      kind: 'gantt',
      title: 'Timeline',
      source: 'table',
      tableId: ids.phases,
      label: `d.${phases[0].id}`,
      start: `d.${phases[1].id}`,
      end: `d.${phases[2].id}`,
      splitBy: `d.${phases[3].id}`,
      limit: 60,
      x: 5,
      y: 11,
      w: 7,
      h: 13,
    },
    table(newId(), 'Schedule of activities', activities, blankRows(5), { x: 0, y: 24, w: 12, h: 8 }),
    {
      ...base,
      id: newId(),
      kind: 'metric',
      title: 'Branches',
      source: 'table',
      tableId: ids.goLive,
      x: 0,
      y: 32,
      w: 4,
      h: 3,
    },
    {
      ...base,
      id: newId(),
      kind: 'metric',
      title: 'Live',
      source: 'table',
      tableId: ids.goLive,
      filters: [{ field: `d.${status}`, op: 'is', values: ['Completed'] }],
      x: 4,
      y: 32,
      w: 4,
      h: 3,
    },
    {
      ...base,
      id: newId(),
      kind: 'metric',
      title: 'On hold or for reset',
      source: 'table',
      tableId: ids.goLive,
      filters: [{ field: `d.${status}`, op: 'is', values: ['On hold', 'For reset'] }],
      x: 8,
      y: 32,
      w: 4,
      h: 3,
    },
    table(ids.goLive, 'Go-live schedule', goLive, blankRows(5), { x: 0, y: 35, w: 8, h: 10 }),
    {
      ...base,
      id: newId(),
      kind: 'pie',
      title: 'Go-live by status',
      source: 'table',
      tableId: ids.goLive,
      groupBy: `d.${status}`,
      limit: 6,
      x: 8,
      y: 35,
      w: 4,
      h: 10,
    },
    table(newId(), 'Risks and issues', risks, blankRows(3), { x: 0, y: 45, w: 12, h: 7 }),
    table(newId(), 'FSD / BRD submitted', documents, blankRows(3), { x: 0, y: 52, w: 12, h: 7 }),
  ]
  return { filters: { range: 'all' }, widgets: settle(widgets) }
}

export const TEMPLATE_KEYS = REPORT_TEMPLATES.map(template => template.id)
