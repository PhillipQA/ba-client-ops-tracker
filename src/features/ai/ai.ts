import type {
  Client,
  PlannerActivity,
  Priority,
  Project,
  UserAccount,
  WaitingOn,
  WorkActivityEvent,
  WorkItem,
} from '../../shared/types'
import { requestJson } from '../../shared/http'
import { cleanDrfPrefill, type DrfPrefill } from '../documents/drfPrefill'
import type { TrackerDraft } from './trackerDraft'
import { composeEmail } from '../email/composeEvent'
import { latestLinkedEmail, replyAllPrefill } from '../email/replyAll'
import { trackerApi } from '../trackers/trackerApi'
import type { Cell } from '../trackers/trackerModel'
import { addTimeEntry } from '../tasks/timeEntries'
import type { EffortCategory } from '../tasks/effort'

export type AISuggestionKind =
  | 'issue'
  | 'requirement'
  | 'follow_up'
  | 'activity'
  | 'draft_reply'
  | 'email_document'
  | 'tracker_draft'
  | 'email_draft'
  | 'task_plan'
  | 'tracker_update'
  | 'time_log'

/** task_plan: tasks from notes, under one client and project. A subtask names a task of the plan or an open task. */
export type PlannedTask = {
  ref: string
  title: string
  description?: string
  assigneeId?: string
  assigneeName?: string
  dueDate?: string
  priority?: Priority
  parentRef?: string
  parentTaskId?: string
  parentTitle?: string
}
export type TaskPlan = {
  clientId: string
  clientName: string
  projectId: string
  projectName: string
  tasks: PlannedTask[]
}
/** tracker_update: changes to a tracker's rows, by row, with each row's version so a row changed since is not overwritten. */
export type TrackerRowChange = {
  rowId: string
  row: number
  version: number
  label: string
  cells: Record<string, Cell>
  changes: { column: string; from: string; to: string }[]
}
export type TrackerChange = { trackerId: string; trackerName: string; rows: TrackerRowChange[] }
/** time_log: one entry on a task. `problem` says why it cannot be logged as it is. */
export type TimeLogDraft = {
  taskId: string
  taskTitle: string
  subtaskId?: string
  subtaskTitle?: string
  date: string
  hours: number
  category: EffortCategory
  note: string
  seedsTaskId?: string
  seedsTaskName?: string
  seeds: boolean
  problem?: string
}

export interface AISuggestion {
  id: string
  kind: AISuggestionKind
  title: string
  rationale: string
  description?: string
  priority?: Priority
  waitingOn?: WaitingOn
  followUpDate?: string
  activityDate?: string
  activityTime?: string
  draft?: string
  /** email_document: the person's own email to link, and the task it goes to (an existing one, or a new one). */
  emailId?: string
  emailSubject?: string
  taskId?: string
  taskTitle?: string
  newTask?: { title: string; clientId: string; projectId: string; clientName?: string; projectName?: string }
  /** email_document: the document to open for that task once the email is linked. */
  document?: 'drf' | 'signoff'
  /** tracker_draft: the tracker to make once approved. */
  tracker?: TrackerDraft
  /** task_plan: the tasks to create, from the ones ticked. */
  plan?: TaskPlan
  /** tracker_update: the row changes to make. */
  trackerChange?: TrackerChange
  /** time_log: the entry to log. */
  timeLog?: TimeLogDraft
}

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  suggestions?: AISuggestion[]
}

export interface AssistantContext {
  currentUser: Pick<UserAccount, 'id' | 'name' | 'role' | 'modules'>
  client?: Client
  project?: Project
  /** Every client and project chosen; a client with none of its projects chosen means all of them. */
  clientIds?: string[]
  projectIds?: string[]
  openItems: WorkItem[]
  recentItems: WorkItem[]
  upcomingActivities: PlannerActivity[]
  myAssignments: WorkItem[]
  myRecentActivity: WorkActivityEvent[]
}

export async function askBAAssistant(
  args: {
    message: string
    context: AssistantContext
    history: AIMessage[]
  },
  signal?: AbortSignal,
): Promise<{ message: string; followUp: string; suggestions: AISuggestion[] }> {
  const response = await fetch('/api/assistant', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })

  const body = (await response.json().catch(() => null)) as {
    error?: string
    message?: string
    followUp?: string
    suggestions?: AISuggestion[]
  } | null
  if (!response.ok) throw new Error(body?.error || 'AI assistant request failed.')
  if (!body?.message) throw new Error('AI assistant returned an empty response.')

  return { message: body.message, followUp: body.followUp?.trim() || '', suggestions: body.suggestions ?? [] }
}

/** A reply as chat messages: the answer with its suggestions, then the "what next?" question as its own message. */
export function assistantMessages(result: { message: string; followUp: string; suggestions: AISuggestion[] }) {
  const createdAt = new Date().toISOString()
  const answer: AIMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: result.message,
    suggestions: result.suggestions.map(suggestion => ({ ...suggestion, id: suggestion.id || crypto.randomUUID() })),
    createdAt,
  }
  const question: AIMessage = { id: crypto.randomUUID(), role: 'assistant', content: result.followUp, createdAt }
  return result.followUp ? [answer, question] : [answer]
}

/**
 * Carries out an approved email_document suggestion: links the email to its task, or makes the task from the email
 * (which links it), and answers with the task. Opening the document is left to the screen.
 */
export async function applyEmailDocument(suggestion: AISuggestion, userId: string) {
  if (!suggestion.emailId) throw new Error('This suggestion does not name an email.')
  const base = `/api/communications/${encodeURIComponent(suggestion.emailId)}`
  if (suggestion.taskId) {
    await requestJson(`${base}/link-task`, {
      body: { taskId: suggestion.taskId },
      fallback: 'The email could not be linked.',
    })
    return { taskId: suggestion.taskId, created: false }
  }
  if (!suggestion.newTask) throw new Error('This suggestion does not name a task.')
  const made = await requestJson<{ task: { id: string } }>(`${base}/create-task`, {
    body: {
      clientId: suggestion.newTask.clientId,
      projectId: suggestion.newTask.projectId,
      title: suggestion.newTask.title,
      description: suggestion.rationale || suggestion.emailSubject || suggestion.newTask.title,
      assignedToUserId: userId,
    },
    fallback: 'The task could not be created from the email.',
  })
  return { taskId: made.task.id, created: true }
}

/**
 * A draft of the DRF's fields from one of the person's own emails, to fill the form for review. Nothing when it
 * cannot be drafted: the DRF then opens empty.
 */
export async function draftDrfFromEmail(emailId: string): Promise<DrfPrefill | undefined> {
  try {
    const result = await requestJson<{ fields?: unknown }>('/api/assistant/drf-draft', { body: { emailId } })
    const fields = cleanDrfPrefill(result.fields)
    return Object.keys(fields).length ? fields : undefined
  } catch {
    return undefined
  }
}

/**
 * Opens an approved follow-up email in the composer: as Reply all on the task's latest linked email when it has one,
 * else as a new email filed under the task. Nothing is sent: the person reviews it and sends it there.
 */
export async function openEmailDraft(suggestion: AISuggestion): Promise<'reply' | 'new'> {
  if (!suggestion.taskId || !suggestion.draft) throw new Error('This draft does not name a task.')
  let received: Awaited<ReturnType<typeof latestLinkedEmail>> = null
  try {
    received = await latestLinkedEmail([suggestion.taskId])
  } catch {
    received = null
  }
  if (received) {
    const reply = await replyAllPrefill(received, [suggestion.taskId])
    composeEmail({ ...reply, message: `${suggestion.draft}${reply.message || ''}` })
    return 'reply'
  }
  composeEmail({
    taskIds: [suggestion.taskId],
    subject: suggestion.emailSubject || suggestion.taskTitle || '',
    message: suggestion.draft,
    notice: 'No email is linked to this task yet, so this is a new email. Add who it goes to.',
  })
  return 'new'
}

/**
 * Makes an approved tracker change, row by row. A row someone changed since the assistant read it is left as it is
 * and reported, like any other row the tracker turns down.
 */
export async function applyTrackerChange(change: TrackerChange) {
  const failed: { label: string; error: string }[] = []
  let done = 0
  for (const row of change.rows) {
    try {
      await trackerApi.updateRow(change.trackerId, row.rowId, { version: row.version, cells: row.cells })
      done++
    } catch (error) {
      failed.push({ label: row.label, error: error instanceof Error ? error.message : 'Not saved.' })
    }
  }
  return { done, failed }
}

/** Logs an approved time entry on its task, by the task's usual time-log rules. */
export function applyTimeLog(log: TimeLogDraft) {
  return addTimeEntry(log.taskId, {
    date: log.date,
    hours: log.hours,
    category: log.category,
    note: log.note,
    ...(log.seedsTaskId ? { seedsTaskId: log.seedsTaskId } : {}),
    ...(log.subtaskId ? { subtaskId: log.subtaskId } : {}),
  })
}

/** The refs a plan creates from those ticked: a subtask only with its task (in the plan) ticked too. */
export function plannedRefs(plan: TaskPlan, ticked: readonly string[]) {
  const chosen = new Set(ticked)
  return plan.tasks
    .filter(task => chosen.has(task.ref) && (!task.parentRef || chosen.has(task.parentRef)))
    .map(task => task.ref)
}

/** Ticking a task in a plan: unticking a task unticks its subtasks; ticking a subtask ticks its task. */
export function togglePlanned(plan: TaskPlan, ticked: readonly string[], ref: string) {
  const task = plan.tasks.find(entry => entry.ref === ref)
  if (!task) return [...ticked]
  if (ticked.includes(ref))
    return ticked.filter(entry => entry !== ref && plan.tasks.find(t => t.ref === entry)?.parentRef !== ref)
  return [...new Set([...ticked, ref, ...(task.parentRef ? [task.parentRef] : [])])]
}
