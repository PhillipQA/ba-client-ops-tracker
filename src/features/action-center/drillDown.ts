/**
 * Action Center drill-down: what lies behind a number. Clicking a count tile, or a bar, slice, point or metric of a
 * report widget, opens a list of exactly the items it counted (DrillPanel). Pure, so the lists can be tested against
 * the numbers they explain.
 */
import type { BuiltinCount, CountTile } from '../../shared/actionCenterSettings'
import { builtinLabel } from '../../shared/actionCenterSettings'
import type { Client, PlannerActivity, Project, TaskSettings, UserAccount, WorkItem } from '../../shared/types'
import { unsentToSeeds } from '../tasks/effort'
import { waitingOnOptions } from '../tasks/waitingOn'
import {
  chartData,
  displayValue,
  type Field,
  type FieldType,
  groupKeyOf,
  matches,
  type Rec,
  widgetRecords,
} from '../reports/custom/reportData'
import type { ReportFilters, Widget } from '../reports/custom/reportModel'

export type DrillColumn = { key: string; label: string; numeric?: boolean }
export type DrillRow = {
  id: string
  /** Text per column, as shown and exported. */
  cells: Record<string, string>
  /** Values to sort by, when the text would sort wrongly (dates, numbers). */
  sort?: Record<string, string | number>
  /** Opens this task when the row is clicked. */
  taskId?: string
}
/** What "Open in Tasks" sets on the Tasks page, when its filters can show the same list. */
export type TasksFilter = { date?: 'overdue'; waitingOn?: string }
export type Drill = {
  title: string
  subtitle?: string
  columns: DrillColumn[]
  rows: DrillRow[]
  tasks?: TasksFilter
}

export type DrillContext = {
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  today: string
}

const late = (item: WorkItem, today: string) =>
  Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today))

export const TASK_COLUMNS: DrillColumn[] = [
  { key: 'task', label: 'Task' },
  { key: 'client', label: 'Client' },
  { key: 'project', label: 'Project' },
  { key: 'status', label: 'Status' },
  { key: 'due', label: 'Due' },
  { key: 'followUp', label: 'Follow-up' },
  { key: 'assignee', label: 'Assignee' },
]

/** Tasks as rows of the panel. */
export function taskRows(items: readonly WorkItem[], context: DrillContext): DrillRow[] {
  const client = new Map(context.clients.map(item => [item.id, item.name]))
  const project = new Map(context.projects.map(item => [item.id, item.name]))
  const person = new Map(context.accounts.map(item => [item.id, item.name]))
  return items.map(item => ({
    id: item.id,
    taskId: item.id,
    cells: {
      task: `${item.title}${item.parentTaskId ? ' (Subtask)' : ''}`,
      client: (item.clientId && client.get(item.clientId)) || '',
      project: (item.projectId && project.get(item.projectId)) || '',
      status: item.status || '',
      due: `${item.dueDate || ''}${item.dueDate && item.dueDate < context.today ? ' · late' : ''}`,
      followUp: `${item.followUpDate || ''}${item.followUpDate && item.followUpDate < context.today ? ' · late' : ''}`,
      assignee: (item.assignedToUserId && person.get(item.assignedToUserId)) || 'Unassigned',
    },
    sort: { due: item.dueDate || '9999', followUp: item.followUpDate || '9999' },
  }))
}

/** What the built-in tiles count, as the page gives it (see countTiles.ts BuiltinInput). */
export type TileInput = {
  open: WorkItem[]
  allItems: WorkItem[]
  taskSettings: TaskSettings
  today: string
  meId: string
  waitingTitle: string
  waitingDev: WorkItem[]
  /** Today's activities and follow-ups (the Activities tile). */
  activities: PlannerActivity[]
  followUps: WorkItem[]
}

/** The tasks a built-in task tile counts; null for the tiles that are not task lists. */
export function builtinItems(id: BuiltinCount, input: TileInput): WorkItem[] | null {
  const { open, today } = input
  switch (id) {
    case 'attention':
      return open
    case 'waitingDev':
      return input.waitingDev
    case 'waitingClient': {
      const client = waitingOnOptions(input.taskSettings).find(option => option.id === 'client' && !option.done)
      return client ? open.filter(item => item.waitingOn === client.label) : []
    }
    case 'overdue':
      return open.filter(item => late(item, today))
    case 'dueToday':
      return open.filter(item => item.dueDate === today || item.followUpDate === today)
    case 'inquiries':
      return open.filter(item => item.type === 'Inquiry')
    default:
      return null
  }
}

/** The Tasks records a person's own tile counts (same rules as customValue). */
export function customRecords(tile: CountTile, records: Rec[], fields: Field[], today: string, meId: string) {
  const types = new Map(fields.map(field => [field.key, field.type]))
  return records.filter(
    record =>
      (tile.all || record.done !== true) &&
      (!tile.mine || record.$user === meId) &&
      (tile.filters || []).every(
        filter => !types.has(filter.field) || matches(record, filter, types.get(filter.field) as FieldType, today),
      ),
  )
}

/** The list behind a count tile. */
export function tileDrill(
  tile: CountTile,
  title: string,
  input: TileInput,
  context: DrillContext,
  custom: { records: Rec[]; fields: Field[] },
): Drill {
  if (!tile.builtin) {
    const ids = new Set(customRecords(tile, custom.records, custom.fields, input.today, input.meId).map(r => r.$id))
    const items = input.allItems.filter(item => ids.has(item.id))
    return { title, subtitle: 'Your own count', columns: TASK_COLUMNS, rows: taskRows(items, context) }
  }
  const id = tile.builtin
  const items = builtinItems(id, input)
  if (items) {
    const waiting =
      id === 'waitingDev'
        ? waitingOnOptions(input.taskSettings).find(
            option => option.label === input.waitingTitle.replace(/^Waiting on /, ''),
          )?.label
        : id === 'waitingClient'
          ? waitingOnOptions(input.taskSettings).find(option => option.id === 'client' && !option.done)?.label
          : undefined
    return {
      title,
      subtitle: builtinLabel(id) === title ? undefined : builtinLabel(id),
      columns: TASK_COLUMNS,
      rows: taskRows(items, context),
      tasks: id === 'overdue' ? { date: 'overdue' } : waiting ? { waitingOn: waiting } : undefined,
    }
  }
  if (id === 'activities') {
    const client = new Map(context.clients.map(item => [item.id, item.name]))
    const rows: DrillRow[] = [
      ...input.activities.map(activity => ({
        id: `activity:${activity.id}`,
        cells: {
          time: activity.allDay ? 'All day' : `${activity.startTime}${activity.endTime ? `–${activity.endTime}` : ''}`,
          what: activity.title,
          kind: activity.source === 'Google Calendar' ? 'Meeting' : 'Tracker activity',
          client: (activity.clientId && client.get(activity.clientId)) || '',
          status: activity.status,
        },
        sort: { time: activity.allDay ? '00:00' : activity.startTime },
      })),
      ...input.followUps.map(item => ({
        id: `follow:${item.id}`,
        taskId: item.id,
        cells: {
          time: '',
          what: item.title,
          kind: 'Follow-up',
          client: (item.clientId && client.get(item.clientId)) || '',
          status: item.status,
        },
        sort: { time: '99:99' },
      })),
    ]
    return {
      title,
      subtitle: 'Today',
      columns: [
        { key: 'time', label: 'Time' },
        { key: 'what', label: 'Activity' },
        { key: 'kind', label: 'Kind' },
        { key: 'client', label: 'Client' },
        { key: 'status', label: 'Status' },
      ],
      rows,
    }
  }
  // Unsent time: each of your time entries not yet sent to Seeds, with its task.
  const client = new Map(context.clients.map(item => [item.id, item.name]))
  const rows: DrillRow[] = []
  for (const item of input.allItems)
    for (const entry of item.timeEntries || [])
      if (entry.userId === input.meId && unsentToSeeds(entry))
        rows.push({
          id: `time:${item.id}:${entry.id}`,
          taskId: item.id,
          cells: {
            date: entry.date,
            task: item.title,
            client: (item.clientId && client.get(item.clientId)) || '',
            hours: String(Math.round((Number(entry.hours) || 0) * 100) / 100),
            note: entry.note || '',
          },
          sort: { hours: Number(entry.hours) || 0 },
        })
  return {
    title,
    subtitle: 'Not yet sent to Seeds',
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'task', label: 'Task' },
      { key: 'client', label: 'Client' },
      { key: 'hours', label: 'Hours', numeric: true },
      { key: 'note', label: 'Note' },
    ],
    rows,
  }
}

/**
 * The records behind a report widget, or one of its groups (a bar, slice, point or summary row): its key, as the
 * chart drew it. "Other" is every group the chart did not draw on its own.
 */
export function widgetDrillRecords(
  widget: Widget,
  all: Rec[],
  fields: Field[],
  filters: ReportFilters,
  today: string,
  groupKey: string | null,
) {
  const records = widgetRecords(widget, all, fields, filters, today)
  if (groupKey === null || !widget.groupBy) return records
  const field = fields.find(item => item.key === widget.groupBy)
  const keyOf = (record: Rec) => groupKeyOf(record, field, widget.bucket).key
  if (groupKey === '__other') {
    const drawn = new Set(
      chartData(widget, records, fields, today)
        .categories.map(category => category.key)
        .filter(key => key !== '__other'),
    )
    return records.filter(record => !drawn.has(keyOf(record)))
  }
  return records.filter(record => keyOf(record) === groupKey)
}

/** Report records as rows of the panel: the widget's table columns, else the source's first fields. */
export function recordRows(records: Rec[], fields: Field[], widget: Widget, tasks: boolean) {
  const byKey = new Map(fields.map(field => [field.key, field]))
  const chosen = (widget.columns || []).map(key => byKey.get(key)).filter((field): field is Field => Boolean(field))
  const shown = (chosen.length ? chosen : fields.filter(field => !field.key.startsWith('$')).slice(0, 7)).slice(0, 10)
  const columns: DrillColumn[] = shown.map(field => ({
    key: field.key,
    label: field.label,
    numeric: field.type === 'number',
  }))
  const rows: DrillRow[] = records.map((record, at) => ({
    id: String(record.$id ?? at),
    ...(tasks && typeof record.$id === 'string' ? { taskId: record.$id } : {}),
    cells: Object.fromEntries(shown.map(field => [field.key, displayValue(record[field.key], field.type)])),
    sort: Object.fromEntries(
      shown.map(field => {
        const value = record[field.key]
        return [field.key, typeof value === 'number' ? value : typeof value === 'string' ? value : String(value ?? '')]
      }),
    ),
  }))
  return { columns, rows }
}

/** Rows in a column's order; text compares as text, numbers as numbers. */
export function sortRows(rows: readonly DrillRow[], key: string, direction: 'asc' | 'desc') {
  const value = (row: DrillRow) => row.sort?.[key] ?? row.cells[key] ?? ''
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = value(a),
      y = value(b)
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign
  })
}

/** Rows with every word of the search somewhere in them. */
export function searchRows(rows: readonly DrillRow[], search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...rows]
  return rows.filter(row => {
    const text = Object.values(row.cells).join(' ').toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** The panel's rows for a CSV file: the header, then each row's text. */
export const drillCsvRows = (drill: Pick<Drill, 'columns'>, rows: readonly DrillRow[]) => [
  drill.columns.map(column => column.label),
  ...rows.map(row => drill.columns.map(column => row.cells[column.key] || '')),
]
