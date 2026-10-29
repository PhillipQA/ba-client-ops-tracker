// Custom reports: where widgets get their numbers. Each data source becomes a list of plain records with named fields,
// so any widget can filter, group and measure any field the same way. Runs in the browser, on the data already loaded.
import type {
  Client,
  PlannerActivity,
  Project,
  TaskSettings,
  UserAccount,
  WorkActivityEvent,
  WorkItem,
} from '../../../shared/types'
import {
  evaluateFormula,
  splitLink,
  type Tracker,
  type TrackerColumn,
  type TrackerRow,
} from '../../trackers/trackerModel'
import { dayNumber, isoOf, mondayOf } from '../../trackers/timelineModel'
import { isWaitingOnDone } from '../../tasks/waitingOn'
import type {
  Bucket,
  DataColor,
  DataTable,
  FilterOp,
  Measure,
  RangePreset,
  ReportFilters,
  SourceId,
  Widget,
  WidgetFilter,
} from './reportModel'

export type FieldType = 'text' | 'number' | 'date' | 'bool'
export type Field = {
  key: string
  label: string
  type: FieldType
  /** Choice columns of fill-in tables: the colour of each choice, used by charts and timelines. */
  colors?: Record<string, DataColor>
}
export type Value = string | number | boolean | null
export type Rec = Record<string, Value>

export type ReportData = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  workEvents: WorkActivityEvent[]
  accounts: UserAccount[]
  taskSettings: TaskSettings
  today: string
  currentUser: UserAccount
  /** Trackers whose rows are loaded, by id. */
  trackers: Record<string, { tracker: Tracker; rows: TrackerRow[] } | undefined>
  /** A date key in the account's business time zone, for activity-log events. */
  dateOf?: (iso: string) => string
}

export const SOURCES: { id: SourceId; label: string; about: string }[] = [
  { id: 'tasks', label: 'Tasks and subtasks', about: 'Status, client, project, assignee, dates, overdue, turnaround.' },
  { id: 'time', label: 'Time logs', about: 'Hours logged on tasks: by person, client, project, kind of work, date.' },
  { id: 'activities', label: 'Planner activities', about: 'Meetings and activities from the planner.' },
  { id: 'events', label: 'Activity log', about: 'Who created, started, completed or reassigned which task, and when.' },
  { id: 'tracker', label: 'Tracker rows', about: "Any tracker's own columns, such as status or % done." },
  { id: 'table', label: 'A table in this report', about: 'What was typed into one of this report’s fill-in tables.' },
]

const TASK_FIELDS: Field[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'kind', label: 'Task or subtask', type: 'text' },
  { key: 'parent', label: 'Parent task', type: 'text' },
  { key: 'client', label: 'Client', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'state', label: 'State (Open, Overdue, Done)', type: 'text' },
  { key: 'done', label: 'Done', type: 'bool' },
  { key: 'overdue', label: 'Overdue', type: 'bool' },
  { key: 'priority', label: 'Priority', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'waitingOn', label: 'Waiting on', type: 'text' },
  { key: 'assignee', label: 'Assigned to', type: 'text' },
  { key: 'owner', label: 'Owner', type: 'text' },
  { key: 'origin', label: 'Came from', type: 'text' },
  { key: 'dateRaised', label: 'Date raised', type: 'date' },
  { key: 'startDate', label: 'Start date', type: 'date' },
  { key: 'dueDate', label: 'Due date', type: 'date' },
  { key: 'followUpDate', label: 'Follow-up date', type: 'date' },
  { key: 'resolvedDate', label: 'Resolved date', type: 'date' },
  { key: 'ageDays', label: 'Age (days)', type: 'number' },
  { key: 'turnaroundDays', label: 'Turnaround (days)', type: 'number' },
  { key: 'progress', label: '% done', type: 'number' },
  { key: 'subtasks', label: 'Subtasks', type: 'number' },
  { key: 'estimateHours', label: 'Estimate (hours)', type: 'number' },
  { key: 'hoursLogged', label: 'Hours logged', type: 'number' },
  { key: 'archived', label: 'Archived', type: 'bool' },
]
const TIME_FIELDS: Field[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'hours', label: 'Hours', type: 'number' },
  { key: 'category', label: 'Kind of work', type: 'text' },
  { key: 'user', label: 'Person', type: 'text' },
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'task', label: 'Task', type: 'text' },
  { key: 'kind', label: 'Task or subtask', type: 'text' },
  { key: 'client', label: 'Client', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
]
const ACTIVITY_FIELDS: Field[] = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'endDate', label: 'End date', type: 'date' },
  { key: 'time', label: 'Time', type: 'text' },
  { key: 'status', label: 'Status', type: 'text' },
  { key: 'origin', label: 'From', type: 'text' },
  { key: 'client', label: 'Client', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'allDay', label: 'All day', type: 'bool' },
  { key: 'hours', label: 'Hours', type: 'number' },
  { key: 'days', label: 'Days', type: 'number' },
]
const EVENT_FIELDS: Field[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'action', label: 'What happened', type: 'text' },
  { key: 'actor', label: 'Done by', type: 'text' },
  { key: 'assignee', label: 'Assigned to', type: 'text' },
  { key: 'item', label: 'Task', type: 'text' },
  { key: 'kind', label: 'Task or subtask', type: 'text' },
  { key: 'client', label: 'Client', type: 'text' },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'field', label: 'Field changed', type: 'text' },
  { key: 'summary', label: 'Summary', type: 'text' },
]

const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  reassigned: 'Reassigned',
  started: 'Started',
  status_changed: 'Status changed',
  updated: 'Updated',
  completed: 'Completed',
  reopened: 'Reopened',
  deleted: 'Deleted',
  evidence_uploaded: 'Evidence added',
  evidence_deleted: 'Evidence removed',
  follow_up_auto_moved: 'Follow-up moved',
  comment_added: 'Comment added',
}

/** A tracker column's field key. */
export const columnKey = (column: Pick<TrackerColumn, 'id'>) => `c.${column.id}`

function trackerFieldType(column: TrackerColumn): FieldType | null {
  switch (column.type) {
    case 'secret':
      return null
    case 'number':
    case 'formula':
      return 'number'
    case 'date':
      return 'date'
    case 'checkbox':
      return 'bool'
    default:
      return 'text'
  }
}

/** A fill-in table column's field key. */
export const tableKey = (column: { id: string }) => `d.${column.id}`

/** The fields a source offers. Tracker rows offer the tracker's own columns (Secret columns never). */
export function sourceFields(source: SourceId, tracker?: Tracker, table?: DataTable): Field[] {
  switch (source) {
    case 'table':
      return (table?.columns || []).map(column => ({
        key: tableKey(column),
        label: column.name,
        type: column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text',
        ...(column.type === 'choice'
          ? { colors: Object.fromEntries((column.options || []).map(option => [option.label, option.color])) }
          : {}),
      }))
    case 'tasks':
      return TASK_FIELDS
    case 'time':
      return TIME_FIELDS
    case 'activities':
      return ACTIVITY_FIELDS
    case 'events':
      return EVENT_FIELDS
    case 'tracker': {
      if (!tracker) return []
      const fields: Field[] = []
      for (const column of tracker.columns) {
        const type = trackerFieldType(column)
        if (type) fields.push({ key: columnKey(column), label: column.name, type })
      }
      fields.push({ key: 'updated', label: 'Last changed', type: 'date' })
      return fields
    }
  }
}

/** Whether the report's client, project and person filters apply to a source. */
export const SOURCE_SCOPE: Record<SourceId, { client: boolean; user: boolean }> = {
  tasks: { client: true, user: true },
  time: { client: true, user: true },
  activities: { client: true, user: false },
  events: { client: true, user: true },
  tracker: { client: false, user: false },
  table: { client: false, user: false },
}

const daysBetween = (start: string, end: string) => {
  const a = dayNumber(start),
    b = dayNumber(end)
  return a === null || b === null ? null : Math.max(0, b - a)
}
const minutesOf = (time: string) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(time || '')
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/**
 * The records of a source, before any filter. People who are not Administrators see their own work only (tasks
 * assigned to them, time they logged, events they took part in), as on the Reports overview. Planner activities are
 * shared, and tracker rows follow the tracker's own access.
 */
export function sourceRecords(source: SourceId, data: ReportData, trackerId = '', table?: DataTable): Rec[] {
  const me = data.currentUser.role === 'Administrator' ? '' : data.currentUser.id
  const clientName = new Map(data.clients.map(client => [client.id, client.name]))
  const projectName = new Map(data.projects.map(project => [project.id, project.name]))
  const userName = new Map(data.accounts.map(account => [account.id, account.name]))
  const closed = new Map(data.taskSettings.statuses.map(status => [status.label, Boolean(status.closed)]))
  const isDone = (item: WorkItem) =>
    (closed.get(item.status) ?? ['Resolved', 'Closed'].includes(item.status)) ||
    isWaitingOnDone(item.waitingOn, data.taskSettings)
  const scope = (item: { clientId?: string; projectId?: string }) => ({
    $client: item.clientId || '',
    $project: item.projectId || '',
    client: (item.clientId && clientName.get(item.clientId)) || '',
    project: (item.projectId && projectName.get(item.projectId)) || '',
  })
  const today = data.today

  switch (source) {
    case 'table':
      // Rows nobody has typed into yet are not counted.
      return (table?.rows || [])
        .filter(row => Object.values(row.cells).some(Boolean))
        .map(row => {
          const record: Rec = { $id: row.id, $user: '' }
          for (const column of table?.columns || []) {
            const value = row.cells[column.id] ?? ''
            if (column.type === 'number') {
              const number = Number(value)
              record[tableKey(column)] = value !== '' && Number.isFinite(number) ? number : null
            } else if (column.type === 'date') record[tableKey(column)] = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
            else record[tableKey(column)] = value
          }
          return record
        })
    case 'tasks': {
      const byId = new Map(data.items.map(item => [item.id, item]))
      const children = new Map<string, WorkItem[]>()
      for (const item of data.items)
        if (item.parentTaskId) children.set(item.parentTaskId, [...(children.get(item.parentTaskId) || []), item])
      return data.items
        .filter(item => !me || item.assignedToUserId === me)
        .map(item => {
          const done = isDone(item)
          const overdue =
            !done && Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today))
          const kids = children.get(item.id) || []
          const kidsDone = kids.filter(isDone).length
          const resolved = item.resolvedDate || ''
          const hours = (item.timeEntries || []).reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0)
          return {
            $id: item.id,
            $user: item.assignedToUserId || '',
            ...scope(item),
            title: item.title,
            kind: item.parentTaskId ? 'Subtask' : 'Task',
            parent: (item.parentTaskId && byId.get(item.parentTaskId)?.title) || '',
            status: item.status,
            state: done ? 'Done' : overdue ? 'Overdue' : 'Open',
            done,
            overdue,
            priority: item.priority || '',
            type: item.type || '',
            waitingOn: item.waitingOn || '',
            assignee: (item.assignedToUserId && userName.get(item.assignedToUserId)) || 'Unassigned',
            owner: item.owner || '',
            origin: item.source || '',
            dateRaised: item.dateRaised || '',
            startDate: item.startDate || '',
            dueDate: item.dueDate || '',
            followUpDate: item.followUpDate || '',
            resolvedDate: resolved,
            ageDays: daysBetween(item.dateRaised, done && resolved ? resolved : today),
            turnaroundDays: done && resolved ? daysBetween(item.dateRaised, resolved) : null,
            progress: kids.length ? Math.round((kidsDone / kids.length) * 100) : done ? 100 : 0,
            subtasks: kids.length,
            estimateHours: typeof item.estimateHours === 'number' ? item.estimateHours : null,
            hoursLogged: Math.round(hours * 100) / 100,
            archived: Boolean(item.archived),
          }
        })
    }
    case 'time': {
      const records: Rec[] = []
      for (const item of data.items)
        for (const entry of item.timeEntries || []) {
          if (me && entry.userId !== me) continue
          records.push({
            $id: entry.id,
            $user: entry.userId,
            ...scope(item),
            date: entry.date,
            hours: Number(entry.hours) || 0,
            category: entry.category,
            user: userName.get(entry.userId) || entry.userName || '',
            note: entry.note || '',
            task: item.title,
            kind: item.parentTaskId ? 'Subtask' : 'Task',
          })
        }
      return records
    }
    case 'activities':
      return data.planner.map(activity => {
        const start = minutesOf(activity.startTime),
          end = minutesOf(activity.endTime)
        const span = daysBetween(activity.date, activity.endDate || activity.date)
        return {
          $id: activity.id,
          $user: '',
          ...scope(activity),
          title: activity.title,
          date: activity.date,
          endDate: activity.endDate || activity.date,
          time: activity.allDay ? 'All day' : `${activity.startTime}–${activity.endTime}`,
          status: activity.status,
          origin: activity.source,
          allDay: activity.allDay,
          hours:
            !activity.allDay && start !== null && end !== null && end > start
              ? Math.round(((end - start) / 60) * 100) / 100
              : null,
          days: span === null ? null : span + 1,
        }
      })
    case 'events':
      return data.workEvents
        .filter(event => !me || event.actorUserId === me || event.assignedToUserId === me)
        .map(event => ({
          $id: event.id,
          $user: event.assignedToUserId || event.actorUserId || '',
          ...scope(event),
          date:
            data.dateOf && event.occurredAt && Number.isFinite(Date.parse(event.occurredAt))
              ? data.dateOf(event.occurredAt)
              : event.date,
          action: ACTION_LABELS[event.action] || event.action,
          actor: event.actorName || '',
          assignee: event.assignedToName || '',
          item: event.itemTitle,
          kind: event.itemKind,
          field: event.field || '',
          summary: event.summary || '',
        }))
    case 'tracker': {
      const loaded = data.trackers[trackerId]
      if (!loaded) return []
      const { tracker, rows } = loaded
      return rows.map(row => {
        const record: Rec = { $id: row.id, $user: '', updated: (row.updatedAt || '').slice(0, 10) }
        for (const column of tracker.columns) {
          const type = trackerFieldType(column)
          if (!type) continue
          const value = row.cells[column.id]
          let out: Value = null
          switch (column.type) {
            case 'formula': {
              const result = evaluateFormula(column, row.cells, tracker.columns)
              out = typeof result.value === 'number' && Number.isFinite(result.value) ? result.value : null
              break
            }
            case 'number':
              out = typeof value === 'number' ? value : value === '' || value == null ? null : Number(value)
              if (typeof out === 'number' && !Number.isFinite(out)) out = null
              break
            case 'checkbox':
              out = value === true
              break
            case 'date':
              out = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
              break
            case 'select':
              out = column.options?.find(option => option.id === value)?.label || ''
              break
            case 'multiselect':
              out = (Array.isArray(value) ? value : [])
                .map(id => column.options?.find(option => option.id === id)?.label || '')
                .filter(Boolean)
                .join(', ')
              break
            case 'person':
              out = (typeof value === 'string' && (userName.get(value) || value)) || ''
              break
            case 'link': {
              const link = splitLink(typeof value === 'string' ? value : '')
              out = link.label || link.address
              break
            }
            default:
              out = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value)
          }
          record[columnKey(column)] = out
        }
        return record
      })
    }
  }
}

// --- Dates and the report's date range ---

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (iso: string) => iso.split('-').map(Number)
const ymd = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** The dates a preset covers, both included, or null for all dates. */
export function rangeDates(filters: ReportFilters, today: string): { from: string; to: string } | null {
  const [year, month] = parts(today)
  const day = dayNumber(today)
  if (day === null) return null
  switch (filters.range) {
    case 'all':
      return null
    case 'this_week': {
      const monday = mondayOf(day)
      return { from: isoOf(monday), to: isoOf(monday + 6) }
    }
    case 'this_month':
      return { from: ymd(year, month, 1), to: ymd(year, month, lastDay(year, month)) }
    case 'last_month': {
      const y = month === 1 ? year - 1 : year,
        m = month === 1 ? 12 : month - 1
      return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)) }
    }
    case 'last_30':
      return { from: isoOf(day - 29), to: today }
    case 'last_90':
      return { from: isoOf(day - 89), to: today }
    case 'this_quarter': {
      const first = Math.floor((month - 1) / 3) * 3 + 1
      return { from: ymd(year, first, 1), to: ymd(year, first + 2, lastDay(year, first + 2)) }
    }
    case 'this_year':
      return { from: ymd(year, 1, 1), to: ymd(year, 12, 31) }
    case 'custom':
      if (!filters.from && !filters.to) return null
      return { from: filters.from || '0000-01-01', to: filters.to || '9999-12-31' }
  }
}

export const RANGE_LABELS: Record<RangePreset, string> = {
  all: 'All dates',
  this_week: 'This week',
  this_month: 'This month',
  last_month: 'Last month',
  last_30: 'Last 30 days',
  last_90: 'Last 90 days',
  this_quarter: 'This quarter',
  this_year: 'This year',
  custom: 'Custom dates',
}

export function niceDate(iso: string) {
  const [year, month, day] = parts(iso)
  if (!year || !month || !day) return iso
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

/** A date's bucket: its key (sorts in date order) and its label. */
export function bucketOf(iso: string, bucket: Bucket): { key: string; label: string } | null {
  const day = dayNumber(iso)
  if (day === null) return null
  const [year, month, date] = parts(isoOf(day))
  switch (bucket) {
    case 'day':
      return { key: isoOf(day), label: `${MONTHS[month - 1]} ${date}` }
    case 'week': {
      const monday = isoOf(mondayOf(day))
      const [, m, d] = parts(monday)
      return { key: monday, label: `${MONTHS[m - 1]} ${d}` }
    }
    case 'month':
      return { key: ymd(year, month, 1), label: `${MONTHS[month - 1]} ${year}` }
    case 'quarter': {
      const quarter = Math.floor((month - 1) / 3)
      return { key: ymd(year, quarter * 3 + 1, 1), label: `Q${quarter + 1} ${year}` }
    }
    case 'year':
      return { key: ymd(year, 1, 1), label: String(year) }
  }
}

/** The bucket after this one, to fill gaps on a time axis. */
function nextBucket(key: string, bucket: Bucket): string {
  const [year, month] = parts(key)
  const day = dayNumber(key) as number
  switch (bucket) {
    case 'day':
      return isoOf(day + 1)
    case 'week':
      return isoOf(day + 7)
    case 'month':
      return month === 12 ? ymd(year + 1, 1, 1) : ymd(year, month + 1, 1)
    case 'quarter':
      return month >= 10 ? ymd(year + 1, 1, 1) : ymd(year, month + 3, 1)
    case 'year':
      return ymd(year + 1, 1, 1)
  }
}

// --- Filters ---

const lower = (value: Value) => (value === null || value === undefined ? '' : String(value)).toLowerCase()
const isEmpty = (value: Value) => value === null || value === undefined || value === ''

export function matches(record: Rec, filter: WidgetFilter, type: FieldType, today: string): boolean {
  const value = record[filter.field] ?? null
  const op: FilterOp = filter.op
  const wanted = (filter.value ?? '').trim()
  const target = wanted.toLowerCase() === 'today' ? today : wanted
  switch (op) {
    case 'empty':
      return isEmpty(value) || value === false
    case 'not_empty':
      return !isEmpty(value) && value !== false
    case 'true':
      return value === true
    case 'false':
      return value !== true
    case 'is':
    case 'is_not': {
      const list = filter.values?.length ? filter.values : wanted ? [wanted] : []
      if (!list.length) return true
      const hit = list.some(item => lower(item) === lower(type === 'bool' ? (value ? 'Yes' : 'No') : value))
      return op === 'is' ? hit : !hit
    }
    case 'contains':
      return !wanted || lower(value).includes(wanted.toLowerCase())
    case 'eq':
    case 'gt':
    case 'lt': {
      if (wanted === '' || typeof value !== 'number') return wanted === ''
      const n = Number(wanted)
      if (!Number.isFinite(n)) return true
      return op === 'eq' ? value === n : op === 'gt' ? value > n : value < n
    }
    case 'before':
    case 'after':
    case 'on': {
      if (!target) return true
      if (typeof value !== 'string' || !value) return false
      const day = value.slice(0, 10)
      return op === 'before' ? day < target : op === 'after' ? day > target : day === target
    }
  }
}

/** The records a widget works on: its source, the report's filters, then its own filters. */
export function widgetRecords(
  widget: Widget,
  all: Rec[],
  fields: Field[],
  filters: ReportFilters,
  today: string,
): Rec[] {
  const range = widget.dateField ? rangeDates(filters, today) : null
  const scope = SOURCE_SCOPE[widget.source]
  const types = new Map(fields.map(field => [field.key, field.type]))
  const own = widget.filters.filter(filter => types.has(filter.field))
  return all.filter(record => {
    if (range && widget.dateField) {
      const value = record[widget.dateField]
      if (typeof value !== 'string' || !value || value.slice(0, 10) < range.from || value.slice(0, 10) > range.to)
        return false
    }
    if (scope.client && filters.clientId && record.$client !== filters.clientId) return false
    if (scope.client && filters.projectId && record.$project !== filters.projectId) return false
    if (scope.user && filters.userId && record.$user !== filters.userId) return false
    return own.every(filter => matches(record, filter, types.get(filter.field) as FieldType, today))
  })
}

// --- Measures and groups ---

export const MEASURE_LABELS: Record<Measure['op'], string> = {
  count: 'Count',
  sum: 'Total',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
  distinct: 'Distinct',
  percent: '% where',
}

export function measureValue(records: Rec[], measure: Measure, fields: Field[], today: string): number | null {
  switch (measure.op) {
    case 'count':
      return records.length
    case 'distinct': {
      if (!measure.field) return records.length
      const field = measure.field
      return new Set(records.map(record => record[field]).filter(value => !isEmpty(value))).size
    }
    case 'percent': {
      if (!records.length) return null
      const where = measure.where
      if (!where) return 100
      const type = fields.find(field => field.key === where.field)?.type || 'text'
      return (records.filter(record => matches(record, where, type, today)).length / records.length) * 100
    }
    default: {
      const field = measure.field
      const numbers = field
        ? records.map(record => record[field]).filter((value): value is number => typeof value === 'number')
        : []
      if (!numbers.length) return measure.op === 'sum' ? 0 : null
      if (measure.op === 'sum') return numbers.reduce((sum, n) => sum + n, 0)
      if (measure.op === 'avg') return numbers.reduce((sum, n) => sum + n, 0) / numbers.length
      if (measure.op === 'min') return Math.min(...numbers)
      return Math.max(...numbers)
    }
  }
}

/** A number as shown: whole numbers as they are, others to one decimal; percentages with %. */
export function formatNumber(value: number | null, measure?: Measure) {
  if (value === null || !Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
  const text = rounded.toLocaleString('en', { maximumFractionDigits: 1 })
  return measure?.op === 'percent' ? `${text}%` : text
}

/** What a measure means, in words: "Count of rows", "Total of Hours". */
export function measureName(measure: Measure, fields: Field[]) {
  const field = fields.find(item => item.key === measure.field)?.label
  if (measure.op === 'count') return 'Count'
  if (measure.op === 'percent') {
    const where = fields.find(item => item.key === measure.where?.field)?.label
    return where ? `% where ${where}` : '%'
  }
  return field ? `${MEASURE_LABELS[measure.op]} ${field}` : MEASURE_LABELS[measure.op]
}

export type Group = { key: string; label: string; records: Rec[] }

const BLANK = '(blank)'
function groupKeyOf(record: Rec, field: Field | undefined, bucket: Bucket | undefined) {
  if (!field) return { key: '', label: '' }
  const value = record[field.key]
  if (field.type === 'date') {
    if (typeof value !== 'string' || !value) return { key: BLANK, label: 'No date' }
    return bucketOf(value, bucket || 'month') || { key: BLANK, label: 'No date' }
  }
  if (field.type === 'bool') return value === true ? { key: 'Yes', label: 'Yes' } : { key: 'No', label: 'No' }
  if (isEmpty(value)) return { key: BLANK, label: 'None' }
  const text = String(value)
  return { key: text, label: text }
}

/** Splits records into groups by a field. Dates are bucketed and come out in date order, with empty buckets filled. */
export function groupRecords(records: Rec[], field: Field | undefined, bucket?: Bucket): Group[] {
  const groups = new Map<string, Group>()
  for (const record of records) {
    const { key, label } = groupKeyOf(record, field, bucket)
    const group = groups.get(key)
    if (group) group.records.push(record)
    else groups.set(key, { key, label, records: [record] })
  }
  const list = [...groups.values()]
  if (field?.type === 'date') {
    const size = bucket || 'month'
    const dated = list.filter(group => group.key !== BLANK).sort((a, b) => a.key.localeCompare(b.key))
    const filled: Group[] = []
    for (let index = 0; index < dated.length; index++) {
      filled.push(dated[index])
      const next = dated[index + 1]
      if (!next) continue
      let key = nextBucket(dated[index].key, size)
      for (let guard = 0; key < next.key && guard < 400; guard++) {
        filled.push({ key, label: bucketOf(key, size)?.label || key, records: [] })
        key = nextBucket(key, size)
      }
    }
    // Rows without the date have no place on a time axis.
    return filled
  }
  return list
}

export type Series = { key: string; label: string; values: (number | null)[] }
export type ChartData = {
  categories: { key: string; label: string }[]
  series: Series[]
  /** The rows behind each category, for tooltips and tables. */
  counts: number[]
}

/**
 * The numbers for a chart: one category per group, one series per split value (or a single series). Categories are
 * sorted by value (largest first), by name, or by date; past the limit they are added up as Other (counts and totals
 * only, as an average of averages would mislead — there the rest are left out).
 */
export function chartData(widget: Widget, records: Rec[], fields: Field[], today: string): ChartData {
  const groupField = fields.find(field => field.key === widget.groupBy)
  const splitField =
    widget.kind === 'pie' || widget.kind === 'bar' ? undefined : fields.find(f => f.key === widget.splitBy)
  let groups = groupRecords(records, groupField, widget.bucket)
  const value = (list: Rec[]) => measureValue(list, widget.measure, fields, today)
  const isTime = groupField?.type === 'date'
  const sort = widget.sort || (isTime ? 'label' : 'value_desc')
  if (!isTime || sort !== 'label') {
    const scored = groups.map(group => ({ group, score: value(group.records) ?? Number.NEGATIVE_INFINITY }))
    if (sort === 'label')
      scored.sort((a, b) => a.group.label.localeCompare(b.group.label, undefined, { numeric: true }))
    else scored.sort((a, b) => (sort === 'value_asc' ? a.score - b.score : b.score - a.score))
    groups = scored.map(entry => entry.group)
  }
  const limit = widget.limit || (widget.kind === 'pie' ? 6 : isTime ? 60 : 12)
  if (groups.length > limit) {
    const kept = groups.slice(0, isTime ? groups.length - limit : limit - 1)
    const rest = groups.slice(isTime ? groups.length - limit : limit - 1)
    if (isTime) groups = rest
    else if (widget.measure.op === 'count' || widget.measure.op === 'sum')
      groups = [...kept, { key: '__other', label: 'Other', records: rest.flatMap(group => group.records) }]
    else groups = groups.slice(0, limit)
  }
  const categories = groups.map(group => ({ key: group.key, label: group.label }))
  const counts = groups.map(group => group.records.length)
  if (!splitField) {
    return {
      categories,
      counts,
      series: [{ key: '', label: measureName(widget.measure, fields), values: groups.map(g => value(g.records)) }],
    }
  }
  // Series: the 7 biggest split values, the rest as Other, in a fixed order so colours follow the value.
  const splitGroups = groupRecords(records, splitField, widget.bucket)
  const ranked = [...splitGroups].sort((a, b) => b.records.length - a.records.length)
  const top = ranked.slice(0, 7).map(group => group.key)
  const named = splitGroups.filter(group => top.includes(group.key))
  named.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  const hasOther = splitGroups.length > top.length
  const seriesKeys = [...named.map(group => ({ key: group.key, label: group.label }))]
  if (hasOther) seriesKeys.push({ key: '__other', label: 'Other' })
  const keyOf = (record: Rec) => {
    const key = groupKeyOf(record, splitField, widget.bucket).key
    return top.includes(key) ? key : '__other'
  }
  return {
    categories,
    counts,
    series: seriesKeys.map(series => ({
      key: series.key,
      label: series.label,
      values: groups.map(group => {
        const subset = group.records.filter(record => keyOf(record) === series.key)
        return subset.length || widget.measure.op === 'count' || widget.measure.op === 'sum' ? value(subset) : null
      }),
    })),
  }
}

/** A field's value as text, for tables and exports. */
export function displayValue(value: Value | undefined, type: FieldType | undefined) {
  if (value === null || value === undefined || value === '') return ''
  if (type === 'bool') return value === true ? 'Yes' : 'No'
  if (type === 'date' && typeof value === 'string') return niceDate(value.slice(0, 10))
  if (typeof value === 'number') return formatNumber(value)
  return String(value)
}

/** Sorts records by a field: empty values last whichever way. */
export function sortRecords(records: Rec[], field: string | undefined, dir: 'asc' | 'desc' = 'asc') {
  if (!field) return records
  const sign = dir === 'asc' ? 1 : -1
  return [...records].sort((a, b) => {
    const x = a[field],
      y = b[field]
    if (isEmpty(x) && isEmpty(y)) return 0
    if (isEmpty(x)) return 1
    if (isEmpty(y)) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign
  })
}

/** The different values a field takes, most common first, for filter pickers. */
export function fieldValues(records: Rec[], field: Field, max = 60): string[] {
  if (field.type === 'bool') return ['Yes', 'No']
  const counts = new Map<string, number>()
  for (const record of records) {
    const value = record[field.key]
    if (isEmpty(value)) continue
    const text = String(value)
    counts.set(text, (counts.get(text) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([value]) => value)
}

/** Date fields of a source, for the "report dates apply to" picker. */
export const dateFields = (fields: Field[]) => fields.filter(field => field.type === 'date')

// --- What a widget shows ---

export type GanttBar = { id: string; label: string; start: string; end: string; group: string }
export type Computed =
  | { kind: 'metric'; value: number | null; rows: number }
  | { kind: 'chart'; chart: ChartData; rows: number }
  | { kind: 'rows'; rows: Rec[]; total: number; columns: Field[] }
  | { kind: 'gantt'; bars: GanttBar[]; total: number }
  | { kind: 'text' }

/** Works out what a widget shows from its source's records. */
export function computeWidget(
  widget: Widget,
  all: Rec[],
  fields: Field[],
  filters: ReportFilters,
  today: string,
): Computed {
  if (widget.kind === 'heading' || widget.kind === 'note' || widget.kind === 'datatable') return { kind: 'text' }
  const records = widgetRecords(widget, all, fields, filters, today)
  switch (widget.kind) {
    case 'metric':
      return { kind: 'metric', value: measureValue(records, widget.measure, fields, today), rows: records.length }
    case 'table': {
      if (widget.groupBy)
        return { kind: 'chart', chart: chartData(widget, records, fields, today), rows: records.length }
      const byKey = new Map(fields.map(field => [field.key, field]))
      const chosen = (widget.columns || []).map(key => byKey.get(key)).filter((field): field is Field => Boolean(field))
      const columns = chosen.length ? chosen : fields.slice(0, 4)
      const sorted = sortRecords(records, widget.orderBy, widget.orderDir)
      return { kind: 'rows', rows: sorted.slice(0, widget.limit || 50), total: records.length, columns }
    }
    case 'gantt': {
      const label = widget.label || fields[0]?.key || ''
      const split = fields.find(field => field.key === widget.splitBy)
      const bars: GanttBar[] = []
      for (const record of records) {
        const startRaw = widget.start ? record[widget.start] : null
        const endRaw = widget.end ? record[widget.end] : null
        const start = typeof startRaw === 'string' && startRaw ? startRaw.slice(0, 10) : ''
        const end = typeof endRaw === 'string' && endRaw ? endRaw.slice(0, 10) : ''
        if (!start && !end) continue
        const from = start || end,
          to = end && end >= from ? end : from
        bars.push({
          id: String(record.$id ?? bars.length),
          label: displayValue(record[label], fields.find(field => field.key === label)?.type) || 'Untitled',
          start: from,
          end: to,
          group: split ? groupKeyOf(record, split, undefined).label : '',
        })
      }
      bars.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
      return { kind: 'gantt', bars: bars.slice(0, widget.limit || 60), total: bars.length }
    }
    default:
      return { kind: 'chart', chart: chartData(widget, records, fields, today), rows: records.length }
  }
}

/** A widget's numbers as CSV rows, for its Download button. */
export function widgetCsv(widget: Widget, computed: Computed, fields: Field[]): string[][] {
  switch (computed.kind) {
    case 'metric':
      return [
        [widget.title || 'Value', measureName(widget.measure, fields)],
        [formatNumber(computed.value, widget.measure), ''],
      ]
    case 'chart': {
      const group = fields.find(field => field.key === widget.groupBy)?.label || 'Group'
      return [
        [group, ...computed.chart.series.map(series => series.label || 'Value'), 'Rows'],
        ...computed.chart.categories.map((category, index) => [
          category.label,
          ...computed.chart.series.map(series => {
            const value = series.values[index]
            return value === null ? '' : String(Math.round(value * 100) / 100)
          }),
          String(computed.chart.counts[index]),
        ]),
      ]
    }
    case 'rows':
      return [
        computed.columns.map(column => column.label),
        ...computed.rows.map(row => computed.columns.map(column => displayValue(row[column.key], column.type))),
      ]
    case 'gantt':
      return [
        ['Name', 'Start', 'End', fields.find(field => field.key === widget.splitBy)?.label || 'Group'],
        ...computed.bars.map(bar => [bar.label, bar.start, bar.end, bar.group]),
      ]
    case 'text':
      return [[widget.text || '']]
  }
}
