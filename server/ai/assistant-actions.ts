/**
 * Actions the BA assistant may prepare for the person to approve:
 *
 * - email_draft: a follow-up email for a task. Approving opens it in the email composer (as a reply on the task's
 *   latest email when it has one); nothing is sent until the person sends it there.
 * - task_plan: tasks and subtasks from meeting notes, under one client and project, with assignees and due dates.
 *   The person ticks which to create.
 * - tracker_update: changes to rows of a tracker the person can edit, shown as before → after.
 * - time_log: one time entry on a task, with its Seeds task and remarks, checked by the same rules as the task's
 *   own time log. Sending it to Seeds stays a separate step on the task.
 *
 * The extra context each action needs goes to the model only when the question asks for that action and the person
 * may do it. Everything the model returns is checked here against what the person can see and change; anything else
 * is dropped. Nothing is saved here: approving does it, through the app's usual routes and rules.
 */
import { isArchived, isClosedProject, isWorkDone } from '../../src/features/tasks/lifecycle'
import { EFFORT_CATEGORIES, seedsTimeRule, validateTimeEntryInput } from '../../src/features/tasks/effort'
import { cleanCell, type Cell, type TrackerColumn } from '../../src/features/trackers/trackerModel'
import { places } from './assistant-emails'
import type { LoadedTracker } from './assistant-trackers'

export const ACTION_LIMITS = { planTasks: 20, planPeople: 60, timeTasks: 15, trackerChanges: 30 } as const

const clip = (value: unknown, length: number) => `${value ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, length)
const list = (state: any, key: string): any[] => (Array.isArray(state?.[key]) ? state[key] : [])
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']
const words = (text: string) => text.toLowerCase().match(/[\p{L}\d]{3,}/gu) || []

/** What the person may do, from their role and pages; each action is offered only when allowed. */
export type ActionRights = { email: boolean; tasks: boolean; trackers: boolean; time: boolean }
export function actionRights(user: { role?: string; editModules?: string[] }, allowed: (module: string) => boolean) {
  const writes = user.role !== 'Viewer'
  const edits = (module: string) =>
    allowed(module) && (!Array.isArray(user.editModules) || user.editModules.includes(module))
  const tasks = writes && (edits('items') || edits('inbox'))
  return { email: writes && allowed('inbox'), tasks, trackers: writes && edits('trackers'), time: tasks }
}

// --- What the question asks for ------------------------------------------------------------------------------------

/** A follow-up, reminder or reply to write. */
export const asksForEmailDraft = (message: string) =>
  /\b(remind|nudge|chase|follow[- ]?up with|reply to|respond to)\b/i.test(message) ||
  /\b(draft|write|compose|prepare|send)\b.{0,40}\b(e-?mails?|messages?|reply|follow[- ]?up|reminder)\b/i.test(message)
/** Tasks from notes, or a request to create tasks. */
export const asksForTaskPlan = (message: string) =>
  /\b(meeting notes?|minutes|notes from|action items?|to-?dos?)\b/i.test(message) ||
  (/\b(tasks?|subtasks?)\b/i.test(message) && /\b(create|make|add|turn|break|split|plan|set ?up)\b/i.test(message))
/** A change to tracker rows. */
export const asksToUpdateTracker = (message: string) =>
  /\b(mark|set|update|change|tick|untick|check|uncheck|fill in|put|move|clear)\b/i.test(message)
/** A time entry to log. */
export const asksToLogTime = (message: string) =>
  /\b(log|record|book|enter|add|put)\b/i.test(message) &&
  /\b(\d+(\.\d+)?\s*(h|hrs?|hours?|m|mins?|minutes?)|time|hours?|an hour|half an hour)\b/i.test(message)

// --- Context ---------------------------------------------------------------------------------------------------------

/** People tasks can be assigned to: active Administrators and Contributors. */
const assignable = (state: any) =>
  list(state, 'accounts').filter(
    account => account?.id && account.status === 'Active' && ['Administrator', 'Contributor'].includes(account.role),
  )

/** What a task plan needs: where tasks can go, and who they can be assigned to. */
export function planningContext(state: any, message: string, requested: any) {
  return {
    about:
      'For tasks from notes: `places` are the clients and open projects the question names; `people` are those tasks can be assigned to.',
    places: places(state, message, requested),
    people: assignable(state)
      .slice(0, ACTION_LIMITS.planPeople)
      .map(account => ({ id: `${account.id}`, name: clip(account.name || account.username, 120) })),
  }
}

/** Open top-level tasks the person may log time on, best match first: named in the message, then their own. */
export function timeLogContext(state: any, user: { id: string }, message: string, requested: any) {
  const seedsOn = state?.seeds?.connected === true
  const settings = state?.taskSettings || { statuses: [] }
  const items = list(state, 'items')
  const terms = new Set(words(message))
  const name = (key: string, id: unknown) =>
    list(state, key).find(entry => entry?.id === id)?.name as string | undefined
  const subtasksOf = (id: string) => items.filter(item => item?.parentTaskId === id && !isArchived(item))
  const focus = { client: `${requested?.client?.id || ''}`, project: `${requested?.project?.id || ''}` }
  const open = items.filter(item => item?.id && !item.parentTaskId && !isArchived(item) && !isWorkDone(item, settings))
  const score = (item: any) => {
    const text = [item.title, name('clients', item.clientId), name('projects', item.projectId)]
      .concat(subtasksOf(item.id).map(subtask => subtask.title))
      .join(' ')
    let points = words(text).filter(word => terms.has(word)).length * 10
    if (item.assignedToUserId === user.id) points += 3
    if (focus.project && item.projectId === focus.project) points += 5
    else if (focus.client && item.clientId === focus.client) points += 2
    return points
  }
  const tasks = open
    .map(item => ({ item, points: score(item) }))
    .filter(entry => entry.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, ACTION_LIMITS.timeTasks)
    .map(({ item }) => {
      const rule = seedsTimeRule(state, item)
      return {
        id: `${item.id}`,
        title: clip(item.title, 200),
        client: name('clients', item.clientId),
        project: name('projects', item.projectId),
        subtasks: subtasksOf(item.id)
          .slice(0, 30)
          .map(subtask => ({ id: `${subtask.id}`, title: clip(subtask.title, 160) })),
        ...(rule ? { seedsTasks: rule.tasks.slice(0, 40), seedsTaskId: rule.taggedTaskId } : {}),
      }
    })
  return {
    about:
      'Open tasks the user may log time on. Time is logged on a task; an entry may name one of its subtasks. With Seeds on, an entry counts toward one of the task’s `seedsTasks`.',
    seedsOn,
    ...(seedsOn ? {} : { categories: [...EFFORT_CATEGORIES] }),
    tasks,
  }
}

// --- What the model is told ------------------------------------------------------------------------------------------

export const EMAIL_DRAFT_INSTRUCTIONS = `
  When the user asks you to remind, follow up, reply or write to someone about a task, add one suggestion of kind "email_draft" with "taskId" (an open task from the context), "subject" and "body": the email text only, polite and short, in the user's voice, with no greeting placeholders like [Name] and no signature. Use only facts from the task and its emails. Say that the email is drafted for them to review and send, never that it was sent.`
export const EMAIL_DRAFT_FIELDS = `,
        "subject": "only for email_draft",
        "body": "only for email_draft"`

export const TASK_PLAN_INSTRUCTIONS = `
  The context includes \`planning\`. When the user pastes notes and asks for tasks, or asks you to create tasks, add one suggestion of kind "task_plan" with "clientId" and "projectId" from planning.places, and "tasks": at most ${ACTION_LIMITS.planTasks} objects with "ref" (T1, T2…), "title", optional "description", "assigneeId" (from planning.people), "dueDate" (YYYY-MM-DD), "priority" (Low | Medium | High | Urgent), and for a subtask either "parentRef" (the ref of a task in this plan) or "parentTaskId" (an open task from the context). Subtasks follow their task's assignee. Use only actions the notes state; do not invent owners or dates. If you cannot tell the client or project, ask instead. Say the tasks are planned for approval, never that they were created.`
export const TASK_PLAN_FIELDS = `,
        "tasks": "only for task_plan: [{ \\"ref\\", \\"title\\", \\"description\\", \\"assigneeId\\", \\"dueDate\\", \\"priority\\", \\"parentRef\\", \\"parentTaskId\\" }]"`

export const TRACKER_UPDATE_INSTRUCTIONS = `
  When the user asks to change cells of a tracker in trackers.details, add one suggestion of kind "tracker_update" with "trackerId" and "changes": at most ${ACTION_LIMITS.trackerChanges} objects { "row": the row number, "column": the column name, "value": the new value }. A choice column takes one of its option names; a checkbox true or false; a date YYYY-MM-DD; "" clears a cell. Find rows by their values (a site or store name), never guess. If the tracker is only listed, not detailed, ask the user to name it. Say the changes are prepared for approval, never that they were made.`
export const TRACKER_UPDATE_FIELDS = `,
        "trackerId": "only for tracker_update",
        "changes": "only for tracker_update: [{ \\"row\\": 1, \\"column\\": \\"name\\", \\"value\\": \\"new value\\" }]"`

export const TIME_LOG_INSTRUCTIONS = `
  The context includes \`timeLog\`. When the user asks to log time, add one suggestion of kind "time_log" with "taskId" (a task in timeLog.tasks), optional "subtaskId" (one of its subtasks, when the user names one), "date" (YYYY-MM-DD; "today" is the date given), "hours" (in 0.25 steps), and "note": the remarks, at most 120 characters (leave it empty to use "subtask – task" when a subtask is named). With timeLog.seedsOn, add "seedsTaskId" from that task's seedsTasks when the user names one, otherwise leave it out. Without Seeds, add "category" from timeLog.categories. If the task is unclear, ask instead of guessing. Say the entry is ready for approval, never that it was logged.`
export const TIME_LOG_FIELDS = `,
        "subtaskId": "only for time_log",
        "date": "only for time_log",
        "hours": "only for time_log",
        "note": "only for time_log",
        "seedsTaskId": "only for time_log",
        "category": "only for time_log without Seeds"`

// --- Checking what the model returned ------------------------------------------------------------------------------

const ofKind = (value: unknown, kind: string) =>
  (Array.isArray(value) ? value.slice(0, 8) : []).filter(
    (raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object' && (raw as any).kind === kind,
  )
const idOf = (item: Record<string, unknown>) => `${item.id || crypto.randomUUID()}`

/** Open tasks this person can see, not archived and not Discord inquiries. */
const openTask = (state: any, id: unknown) => {
  const settings = state?.taskSettings || { statuses: [] }
  return list(state, 'items').find(
    item =>
      `${item?.id}` === `${id}` &&
      !isArchived(item) &&
      !isWorkDone(item, settings) &&
      !(item.source === 'Discord' && item.externalSourceId),
  )
}

/** A follow-up email for an open task: subject and text, for the composer. At most 2. */
export function emailDraftSuggestions(value: unknown, state: any) {
  return ofKind(value, 'email_draft')
    .flatMap(item => {
      const task = openTask(state, item.taskId)
      const body = `${item.body ?? item.draft ?? ''}`.replace(/\r\n?/g, '\n').trim().slice(0, 4000)
      if (!task || !body) return []
      return [
        {
          id: idOf(item),
          kind: 'email_draft',
          title: clip(item.title, 180) || `Email about “${clip(task.title, 120)}”`,
          rationale: clip(item.rationale, 600),
          taskId: `${task.id}`,
          taskTitle: clip(task.title, 200),
          emailSubject: clip(item.subject, 200) || clip(task.title, 200),
          draft: body,
        },
      ]
    })
    .slice(0, 2)
}

/**
 * Tasks from notes, under one active client and open project of this person's: titles, known assignees, valid dates,
 * and subtasks under a task of the plan or an open task of that project. At most one plan.
 */
export function taskPlanSuggestions(value: unknown, state: any) {
  const people = new Map(
    assignable(state).map(account => [`${account.id}`, clip(account.name || account.username, 120)]),
  )
  return ofKind(value, 'task_plan')
    .flatMap(item => {
      const project = list(state, 'projects').find(entry => entry?.id === item.projectId && !isClosedProject(entry))
      const clientId = project?.clientId || item.clientId
      const client = list(state, 'clients').find(entry => entry?.id === clientId && !isArchived(entry))
      if (!project || !client || (project.clientId && project.clientId !== client.id)) return []
      const raw = (Array.isArray(item.tasks) ? item.tasks : []).slice(0, ACTION_LIMITS.planTasks) as any[]
      const refs = new Set<string>()
      const planned = raw.flatMap((task, index) => {
        const title = clip(task?.title, 200)
        if (!title) return []
        let ref = clip(task?.ref, 12).toUpperCase() || `T${index + 1}`
        if (refs.has(ref)) ref = `T${index + 1}-${refs.size}`
        refs.add(ref)
        const assigneeId = people.has(`${task?.assigneeId}`) ? `${task.assigneeId}` : undefined
        return [
          {
            ref,
            title,
            description: clip(task?.description, 1200) || undefined,
            assigneeId,
            assigneeName: assigneeId ? people.get(assigneeId) : undefined,
            dueDate: isDate(task?.dueDate) ? task.dueDate : undefined,
            priority: PRIORITIES.includes(task?.priority) ? task.priority : undefined,
            parentRef: task?.parentRef ? clip(task.parentRef, 12).toUpperCase() : undefined,
            parentTaskId: task?.parentTaskId ? `${task.parentTaskId}` : undefined,
          },
        ]
      })
      const topRefs = new Set(planned.filter(task => !task.parentRef && !task.parentTaskId).map(task => task.ref))
      const tasks = planned.flatMap(task => {
        if (task.parentRef) {
          if (!topRefs.has(task.parentRef) || task.parentRef === task.ref) return []
          return [{ ...task, parentTaskId: undefined, assigneeId: undefined, assigneeName: undefined }]
        }
        if (task.parentTaskId) {
          const parent = openTask(state, task.parentTaskId)
          if (!parent || parent.parentTaskId || parent.projectId !== project.id) return []
          return [
            {
              ...task,
              parentRef: undefined,
              parentTitle: clip(parent.title, 200),
              assigneeId: undefined,
              assigneeName: undefined,
            },
          ]
        }
        return [task]
      })
      if (!tasks.length) return []
      return [
        {
          id: idOf(item),
          kind: 'task_plan',
          title: clip(item.title, 180) || `Create ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
          rationale: clip(item.rationale, 600),
          plan: {
            clientId: `${client.id}`,
            clientName: clip(client.name, 120),
            projectId: `${project.id}`,
            projectName: clip(project.name, 120),
            tasks,
          },
        },
      ]
    })
    .slice(0, 1)
}

/** Columns the assistant may change, and how a value reads on the card. */
const EDITABLE = new Set(['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'link'])
const shown = (column: TrackerColumn, value: Cell | undefined) => {
  if (column.type === 'checkbox') return value === true ? 'ticked' : 'not ticked'
  if (value === null || value === undefined || value === '') return '—'
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || `${value}`
  return clip(value, 120)
}
/** A choice column is given an option's name; the cell keeps its id. */
const rawFor = (column: TrackerColumn, value: unknown) => {
  if (column.type !== 'select' || value === '' || value === null || value === undefined) return value
  const wanted = `${value}`.trim().toLowerCase()
  return (
    column.options?.find(option => option.label.trim().toLowerCase() === wanted || option.id === value)?.id ?? value
  )
}

/**
 * Row changes for trackers the assistant read for this question and the person can edit: known rows, columns that
 * can be typed into (not Secret, formula or connected ones), values that fit the column, and only real changes.
 * Grouped by row, with the row's version, so a row changed since is not overwritten. At most 2 trackers.
 */
export function trackerUpdateSuggestions(value: unknown, loaded: LoadedTracker[]) {
  return ofKind(value, 'tracker_update')
    .flatMap(item => {
      const entry = loaded.find(candidate => candidate.tracker.id === item.trackerId)
      if (!entry || !entry.tracker.canEdit || entry.tracker.archived) return []
      const { tracker, rows } = entry
      const columns = tracker.columns.filter(column => EDITABLE.has(column.type))
      const byRow = new Map<
        number,
        { rowId: string; row: number; version: number; label: string; cells: Record<string, Cell>; changes: any[] }
      >()
      for (const change of (Array.isArray(item.changes) ? item.changes : []).slice(0, ACTION_LIMITS.trackerChanges)) {
        const number = Number((change as any)?.row)
        const row = Number.isInteger(number) ? rows[number - 1] : undefined
        const name = clip((change as any)?.column, 120).toLowerCase()
        const column = columns.find(candidate => candidate.name.trim().toLowerCase() === name)
        if (!row || !column) continue
        const cleaned = cleanCell(column, rawFor(column, (change as any)?.value))
        if (!cleaned.ok) continue
        const before = row.cells[column.id]
        if (JSON.stringify(before ?? null) === JSON.stringify(cleaned.value ?? null)) continue
        const firstText = tracker.columns.find(
          candidate => ['text', 'select'].includes(candidate.type) && row.cells[candidate.id],
        )
        const group = byRow.get(number) || {
          rowId: row.id,
          row: number,
          version: row.version,
          label: firstText ? shown(firstText, row.cells[firstText.id]) : `Row ${number}`,
          cells: {},
          changes: [],
        }
        group.cells[column.id] = cleaned.value
        group.changes = group.changes.filter(existing => existing.column !== column.name)
        group.changes.push({ column: column.name, from: shown(column, before), to: shown(column, cleaned.value) })
        byRow.set(number, group)
      }
      if (!byRow.size) return []
      return [
        {
          id: idOf(item),
          kind: 'tracker_update',
          title: clip(item.title, 180) || `Update “${clip(tracker.name, 120)}”`,
          rationale: clip(item.rationale, 600),
          trackerChange: {
            trackerId: tracker.id,
            trackerName: clip(tracker.name, 120),
            rows: [...byRow.values()].sort((a, b) => a.row - b.row),
          },
        },
      ]
    })
    .slice(0, 2)
}

/**
 * A time entry on an open task of this person's, checked with the task's own time-log rules (Seeds task, remarks,
 * 15-minute steps). When those rules turn it down, the card says why and cannot be approved. At most 3.
 */
export function timeLogSuggestions(value: unknown, state: any, today: string) {
  const items = list(state, 'items')
  return ofKind(value, 'time_log')
    .flatMap(item => {
      // A subtask named as the task: log on its task, for that subtask.
      let task = openTask(state, item.taskId)
      let subtaskId = item.subtaskId ? `${item.subtaskId}` : undefined
      if (task?.parentTaskId) {
        subtaskId = `${task.id}`
        task = openTask(state, task.parentTaskId)
      }
      if (!task || task.parentTaskId) return []
      const subtask = subtaskId
        ? items.find(entry => `${entry?.id}` === subtaskId && entry.parentTaskId === task.id)
        : undefined
      if (subtaskId && !subtask) subtaskId = undefined
      const rule = seedsTimeRule(state, task)
      const hours = Number(item.hours)
      const input = {
        date: item.date === 'today' ? today : item.date,
        hours,
        note: clip(item.note, 500),
        category: EFFORT_CATEGORIES.includes(item.category as any) ? item.category : 'Other',
        ...(item.seedsTaskId ? { seedsTaskId: `${item.seedsTaskId}` } : {}),
        ...(subtaskId ? { subtaskId } : {}),
      }
      const checked = validateTimeEntryInput(input, rule)
      const future = isDate(input.date) && input.date > today
      const entry = checked.ok ? checked.value : undefined
      const seedsTaskId = entry?.seedsTaskId || input.seedsTaskId
      return [
        {
          id: idOf(item),
          kind: 'time_log',
          title: clip(item.title, 180) || `Log time on “${clip(task.title, 120)}”`,
          rationale: clip(item.rationale, 600),
          timeLog: {
            taskId: `${task.id}`,
            taskTitle: clip(task.title, 200),
            ...(subtask ? { subtaskId: `${subtask.id}`, subtaskTitle: clip(subtask.title, 200) } : {}),
            date: isDate(input.date) ? input.date : today,
            hours: Number.isFinite(hours) ? hours : 0,
            category: entry?.category || input.category,
            note: entry?.note || input.note,
            ...(seedsTaskId
              ? {
                  seedsTaskId,
                  seedsTaskName: rule?.tasks.find(candidate => candidate.id === seedsTaskId)?.name,
                }
              : {}),
            seeds: Boolean(rule),
            problem: future ? 'Time can’t be logged for a future date.' : checked.ok ? undefined : checked.error,
          },
        },
      ]
    })
    .slice(0, 3)
}
