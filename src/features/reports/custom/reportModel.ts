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
  definitionBytes: 200_000,
} as const

export type SourceId = 'tasks' | 'time' | 'activities' | 'events' | 'tracker'
export const SOURCE_IDS: SourceId[] = ['tasks', 'time', 'activities', 'events', 'tracker']

export type WidgetKind = 'metric' | 'bar' | 'column' | 'line' | 'pie' | 'table' | 'gantt' | 'heading' | 'note'
export const WIDGET_KINDS: WidgetKind[] = [
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
}

export type ReportFilters = {
  range: RangePreset
  from?: string
  to?: string
  clientId?: string
  projectId?: string
  userId?: string
}
export type ReportDefinition = { widgets: Widget[]; filters: ReportFilters }

export type ReportItem = {
  id: string
  kind: 'report' | 'folder'
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
}

/** A sensible size for each kind of widget, in grid cells. */
export const WIDGET_SIZES: Record<WidgetKind, { w: number; h: number }> = {
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
  return widget
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
  return { widgets: settle(widgets), filters: cleanReportFilters(input.filters) }
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
  }
}

type Seed = Omit<Widget, 'id' | 'filters' | 'measure'> & Partial<Pick<Widget, 'filters' | 'measure'>>
const seed = (widgets: Seed[]): Widget[] =>
  settle(widgets.map(widget => ({ filters: [], measure: { op: 'count' }, ...widget, id: newId() }) as Widget))
const open: WidgetFilter = { field: 'done', op: 'false' }

export type ReportTemplate = { id: string; name: string; about: string; build: () => ReportDefinition }
export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: 'blank',
    name: 'Blank report',
    about: 'An empty page. Drag widgets onto it.',
    build: emptyDefinition,
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
