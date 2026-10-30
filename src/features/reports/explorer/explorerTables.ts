// Data explorer: the account's data laid out as plain, read-only tables for SQL. Each table holds only what the
// person can already see in the app, and nothing secret: Secret tracker columns and email bodies are left out.
import type {
  Client,
  PlannerActivity,
  Project,
  TaskSettings,
  UserAccount,
  WorkActivityEvent,
  WorkItem,
} from '../../../shared/types'
import type { Tracker, TrackerRow } from '../../trackers/trackerModel'
import { sourceFields, sourceRecords, type ReportData } from '../custom/reportData'
import { isKeyword, type SqlColumnType, type SqlRow, type SqlTable, type SqlValue } from './sqlEngine'

export type ExplorerMessage = {
  id: string
  source: string
  subject: string
  sender: string
  status: string
  received_at: string
  read_at?: string | null
  client_id?: string | null
  project_id?: string | null
  linked_task_id?: string | null
}

export type ExplorerInput = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  workEvents: WorkActivityEvent[]
  accounts: UserAccount[]
  taskSettings: TaskSettings
  today: string
  currentUser: UserAccount
  dateOf?: (iso: string) => string
  /** Trackers the person can open (the list), and those whose rows are loaded. */
  trackers: Tracker[]
  trackerRows: Record<string, { tracker: Tracker; rows: TrackerRow[] } | undefined>
  /** Work Hub messages, once loaded; null when the person has no Work Hub. */
  messages: ExplorerMessage[] | null | undefined
  /**
   * The whole account's work, as an Administrator sees it in reports: for Administrators and people given Data
   * explorer. Others (people viewing a report with a query on it) get their own work, as in every other widget.
   */
  wholeAccount: boolean
}

export type TableInfo = {
  name: string
  about: string
  columns: { name: string; type: SqlColumnType }[]
  /** Tracker tables and messages are loaded the first time a query reads them. */
  load?: { kind: 'tracker'; trackerId: string } | { kind: 'messages' }
}

type ColumnSpec = [string, SqlColumnType]
const spec = (columns: ColumnSpec[]) => columns.map(([name, type]) => ({ name, type }))

const TASK_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['parent_id', 'text'],
  ['kind', 'text'],
  ['title', 'text'],
  ['client_id', 'text'],
  ['client', 'text'],
  ['project_id', 'text'],
  ['project', 'text'],
  ['status', 'text'],
  ['state', 'text'],
  ['done', 'bool'],
  ['overdue', 'bool'],
  ['priority', 'text'],
  ['type', 'text'],
  ['waiting_on', 'text'],
  ['assignee_id', 'text'],
  ['assignee', 'text'],
  ['owner', 'text'],
  ['came_from', 'text'],
  ['date_raised', 'date'],
  ['start_date', 'date'],
  ['due_date', 'date'],
  ['follow_up_date', 'date'],
  ['resolved_date', 'date'],
  ['age_days', 'number'],
  ['turnaround_days', 'number'],
  ['progress', 'number'],
  ['subtasks', 'number'],
  ['estimate_hours', 'number'],
  ['hours_logged', 'number'],
  ['archived', 'bool'],
]
const TIME_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['task_id', 'text'],
  ['task', 'text'],
  ['date', 'date'],
  ['hours', 'number'],
  ['category', 'text'],
  ['user_id', 'text'],
  ['user', 'text'],
  ['note', 'text'],
  ['client_id', 'text'],
  ['client', 'text'],
  ['project_id', 'text'],
  ['project', 'text'],
]
const CLIENT_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['name', 'text'],
  ['contact', 'text'],
  ['email', 'text'],
  ['status', 'text'],
  ['health', 'text'],
  ['archived', 'bool'],
]
const PROJECT_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['name', 'text'],
  ['status', 'text'],
  ['target_date', 'date'],
  ['summary', 'text'],
  ['archived', 'bool'],
]
const ACTIVITY_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['title', 'text'],
  ['date', 'date'],
  ['end_date', 'date'],
  ['start_time', 'text'],
  ['end_time', 'text'],
  ['all_day', 'bool'],
  ['hours', 'number'],
  ['status', 'text'],
  ['source', 'text'],
  ['client_id', 'text'],
  ['client', 'text'],
  ['project_id', 'text'],
  ['project', 'text'],
]
const LOG_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['date', 'date'],
  ['occurred_at', 'text'],
  ['action', 'text'],
  ['actor', 'text'],
  ['assignee', 'text'],
  ['task_id', 'text'],
  ['parent_task_id', 'text'],
  ['item', 'text'],
  ['kind', 'text'],
  ['client_id', 'text'],
  ['client', 'text'],
  ['project_id', 'text'],
  ['project', 'text'],
  ['field', 'text'],
  ['old_value', 'text'],
  ['new_value', 'text'],
]
const USER_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['name', 'text'],
  ['email', 'text'],
  ['role', 'text'],
  ['status', 'text'],
]
const MESSAGE_COLUMNS: ColumnSpec[] = [
  ['id', 'text'],
  ['source', 'text'],
  ['subject', 'text'],
  ['sender', 'text'],
  ['status', 'text'],
  ['received_date', 'date'],
  ['received_at', 'text'],
  ['read', 'bool'],
  ['client_id', 'text'],
  ['project_id', 'text'],
  ['task_id', 'text'],
]

/** A name that can be written in SQL without quotes: lower case, letters, digits and _. */
export function sqlName(text: string, taken: Set<string> = new Set()) {
  let name =
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/%/g, ' pct ')
      .replace(/#/g, ' no ')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'column'
  if (/^[0-9]/.test(name)) name = `c_${name}`
  if (isKeyword(name)) name = `${name}_value`
  let unique = name
  for (let count = 2; taken.has(unique); count++) unique = `${name}_${count}`
  taken.add(unique)
  return unique
}

/** The tables of each tracker: its name in SQL, and its own columns (never Secret ones). */
function trackerTables(trackers: Tracker[], clients: Client[]) {
  const taken = new Set([
    'tasks',
    'time_entries',
    'clients',
    'projects',
    'activities',
    'activity_log',
    'users',
    'messages',
  ])
  const clientName = new Map(clients.map(client => [client.id, client.name]))
  return trackers.map(tracker => {
    const names = new Set<string>(['row_id'])
    const columns = (sourceFields('tracker', tracker) || [])
      .filter(field => field.key !== 'updated')
      .map(field => ({ key: field.key, name: sqlName(field.label, names), type: field.type as SqlColumnType }))
    const clientColumn = names.has('client') ? null : sqlName('client', names)
    return {
      tracker,
      name: sqlName(`tracker ${tracker.name}`, taken),
      columns,
      clientColumn,
      clientNames: (tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : [])
        .map(id => clientName.get(id) || '')
        .filter(Boolean)
        .join(', '),
    }
  })
}

/** The tables, their columns and what they hold, for the sidebar, the builder and autocomplete. */
export function explorerCatalog(input: Pick<ExplorerInput, 'trackers' | 'clients' | 'messages'>): TableInfo[] {
  const catalog: TableInfo[] = [
    {
      name: 'tasks',
      about: 'Tasks and subtasks, with client, project, status, dates and hours.',
      columns: spec(TASK_COLUMNS),
    },
    { name: 'time_entries', about: 'Time logged on tasks.', columns: spec(TIME_COLUMNS) },
    { name: 'clients', about: 'Clients.', columns: spec(CLIENT_COLUMNS) },
    { name: 'projects', about: 'Projects.', columns: spec(PROJECT_COLUMNS) },
    { name: 'activities', about: 'Planner activities and meetings.', columns: spec(ACTIVITY_COLUMNS) },
    {
      name: 'activity_log',
      about: 'Who created, started, completed or changed which task, and when.',
      columns: spec(LOG_COLUMNS),
    },
    { name: 'users', about: 'People on the account.', columns: spec(USER_COLUMNS) },
  ]
  if (input.messages !== null)
    catalog.push({
      name: 'messages',
      about: 'Your latest 200 Work Hub emails and Discord messages: subject, sender, date and status (never the body).',
      columns: spec(MESSAGE_COLUMNS),
      load: { kind: 'messages' },
    })
  for (const table of trackerTables(input.trackers, input.clients))
    catalog.push({
      name: table.name,
      about: `Rows of the tracker “${table.tracker.name}”.`,
      columns: [
        { name: 'row_id', type: 'text' },
        ...table.columns.map(column => ({ name: column.name, type: column.type })),
        ...(table.clientColumn ? [{ name: table.clientColumn, type: 'text' as SqlColumnType }] : []),
        { name: 'updated', type: 'date' },
      ],
      load: { kind: 'tracker', trackerId: table.tracker.id },
    })
  return catalog
}

/** The rows of every table that is loaded. Tracker tables whose rows are not loaded yet are left out. */
export function explorerTables(input: ExplorerInput): Record<string, SqlTable> {
  const me = input.wholeAccount ? '' : input.currentUser.id
  const data: ReportData = {
    clients: input.clients,
    projects: input.projects,
    items: input.items,
    planner: input.planner,
    workEvents: input.workEvents,
    accounts: input.accounts,
    taskSettings: input.taskSettings,
    today: input.today,
    currentUser: input.wholeAccount ? { ...input.currentUser, role: 'Administrator' } : input.currentUser,
    trackers: input.trackerRows,
    dateOf: input.dateOf,
  }
  const table = (name: string, columns: ColumnSpec[], rows: SqlRow[]): SqlTable => ({
    name,
    columns: spec(columns),
    rows,
  })
  const byTask = new Map(input.items.map(item => [item.id, item]))
  const userName = new Map(input.accounts.map(account => [account.id, account.name]))
  const value = (raw: unknown): SqlValue => (raw === undefined || raw === null || raw === '' ? null : (raw as SqlValue))

  const tasks = sourceRecords('tasks', data).map(record => ({
    id: value(record.$id),
    parent_id: value(byTask.get(String(record.$id))?.parentTaskId),
    kind: value(record.kind),
    title: value(record.title),
    client_id: value(record.$client),
    client: value(record.client),
    project_id: value(record.$project),
    project: value(record.project),
    status: value(record.status),
    state: value(record.state),
    done: record.done === true,
    overdue: record.overdue === true,
    priority: value(record.priority),
    type: value(record.type),
    waiting_on: value(record.waitingOn),
    assignee_id: value(record.$user),
    assignee: value(record.assignee),
    owner: value(record.owner),
    came_from: value(record.origin),
    date_raised: value(record.dateRaised),
    start_date: value(record.startDate),
    due_date: value(record.dueDate),
    follow_up_date: value(record.followUpDate),
    resolved_date: value(record.resolvedDate),
    age_days: value(record.ageDays),
    turnaround_days: value(record.turnaroundDays),
    progress: value(record.progress),
    subtasks: value(record.subtasks),
    estimate_hours: value(record.estimateHours),
    hours_logged: value(record.hoursLogged),
    archived: record.archived === true,
  }))
  const time: SqlRow[] = []
  const clientName = new Map(input.clients.map(client => [client.id, client.name]))
  const projectName = new Map(input.projects.map(project => [project.id, project.name]))
  for (const item of input.items)
    for (const entry of item.timeEntries || []) {
      if (me && entry.userId !== me) continue
      time.push({
        id: entry.id,
        task_id: item.id,
        task: item.title,
        date: value(entry.date),
        hours: Number(entry.hours) || 0,
        category: value(entry.category),
        user_id: value(entry.userId),
        user: value(userName.get(entry.userId) || entry.userName),
        note: value(entry.note),
        client_id: value(item.clientId),
        client: value(item.clientId && clientName.get(item.clientId)),
        project_id: value(item.projectId),
        project: value(item.projectId && projectName.get(item.projectId)),
      })
    }
  const activities = sourceRecords('activities', data).map(record => {
    const activity = input.planner.find(entry => entry.id === record.$id)
    return {
      id: value(record.$id),
      title: value(record.title),
      date: value(record.date),
      end_date: value(record.endDate),
      start_time: value(activity?.allDay ? '' : activity?.startTime),
      end_time: value(activity?.allDay ? '' : activity?.endTime),
      all_day: record.allDay === true,
      hours: value(record.hours),
      status: value(record.status),
      source: value(record.origin),
      client_id: value(record.$client),
      client: value(record.client),
      project_id: value(record.$project),
      project: value(record.project),
    }
  })
  const log = sourceRecords('events', data).map(record => {
    const event = input.workEvents.find(entry => entry.id === record.$id)
    return {
      id: value(record.$id),
      date: value(record.date),
      occurred_at: value(event?.occurredAt),
      action: value(record.action),
      actor: value(record.actor),
      assignee: value(record.assignee),
      task_id: value(event?.taskId),
      parent_task_id: value(event?.parentTaskId),
      item: value(record.item),
      kind: value(record.kind),
      client_id: value(record.$client),
      client: value(record.client),
      project_id: value(record.$project),
      project: value(record.project),
      field: value(record.field),
      old_value: value(event?.oldValue),
      new_value: value(event?.newValue),
    }
  })
  const tables: Record<string, SqlTable> = {
    tasks: table('tasks', TASK_COLUMNS, tasks),
    time_entries: table('time_entries', TIME_COLUMNS, time),
    clients: table(
      'clients',
      CLIENT_COLUMNS,
      input.clients.map(client => ({
        id: client.id,
        name: client.name,
        contact: value(client.contact),
        email: value(client.email),
        status: value(client.status),
        health: value(client.health),
        archived: Boolean(client.archived),
      })),
    ),
    projects: table(
      'projects',
      PROJECT_COLUMNS,
      input.projects.map(project => ({
        id: project.id,
        name: project.name,
        status: value(project.status),
        target_date: value(project.targetDate),
        summary: value(project.summary),
        archived: Boolean(project.archived),
      })),
    ),
    activities: table('activities', ACTIVITY_COLUMNS, activities),
    activity_log: table('activity_log', LOG_COLUMNS, log),
    users: table(
      'users',
      USER_COLUMNS,
      input.accounts.map(account => ({
        id: account.id,
        name: account.name,
        email: value(account.email),
        role: value(account.role),
        status: value(account.status),
      })),
    ),
  }
  if (input.messages)
    tables.messages = table(
      'messages',
      MESSAGE_COLUMNS,
      input.messages.map(message => ({
        id: message.id,
        source: value(message.source),
        subject: value(message.subject),
        sender: value(message.sender),
        status: value(message.status),
        received_date: value(
          message.received_at && (input.dateOf ? input.dateOf(message.received_at) : message.received_at.slice(0, 10)),
        ),
        received_at: value(message.received_at),
        read: 'read_at' in message ? Boolean(message.read_at) : null,
        client_id: value(message.client_id),
        project_id: value(message.project_id),
        task_id: value(message.linked_task_id),
      })),
    )
  for (const tracker of trackerTables(input.trackers, input.clients)) {
    const loaded = input.trackerRows[tracker.tracker.id]
    if (!loaded) continue
    const records = sourceRecords(
      'tracker',
      { ...data, trackers: { [tracker.tracker.id]: loaded } },
      tracker.tracker.id,
    )
    tables[tracker.name] = {
      name: tracker.name,
      columns: [
        { name: 'row_id', type: 'text' },
        ...tracker.columns.map(column => ({ name: column.name, type: column.type })),
        ...(tracker.clientColumn ? [{ name: tracker.clientColumn, type: 'text' as SqlColumnType }] : []),
        { name: 'updated', type: 'date' },
      ],
      rows: records.map(record => {
        const row: SqlRow = { row_id: value(record.$id), updated: value(record.updated) }
        for (const column of tracker.columns) row[column.name] = value(record[column.key])
        if (tracker.clientColumn) row[tracker.clientColumn] = value(tracker.clientNames)
        return row
      }),
    }
  }
  return tables
}
