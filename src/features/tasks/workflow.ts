/**
 * An account's workflow: task statuses, waiting-on options, visible task columns, and the names shown for
 * priorities and client health. Each account's Administrator edits it (Settings › Workflow); Internal Admin can too.
 *
 * Tasks keep status and waiting-on as names, so a rename carries over to every task that uses it, and a status
 * that tasks still use is removed only by saying where those tasks move. Priorities and health keep their fixed
 * values (the app sorts and colours by them); only the names people see change.
 */
import type {
  Client,
  Priority,
  TaskColumnKey,
  TaskSettings,
  TaskStatusDefinition,
  WorkflowLabels,
} from '../../shared/types'
import { applyWaitingOnRenames, planWaitingOnUpdate, waitingOnOptions } from './waitingOn'
import { cleanFieldDefs } from './customFields'

export const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Urgent']
export const HEALTHS: Client['health'][] = ['Good', 'Watch', 'At Risk']
export const TASK_COLUMNS: [TaskColumnKey, string][] = [
  ['status', 'Status'],
  ['client', 'Client'],
  ['project', 'Project'],
  ['type', 'Type'],
  ['waitingOn', 'Waiting on'],
  ['priority', 'Priority'],
  ['owner', 'Owner'],
  ['startDate', 'Start date'],
  ['dueDate', 'Due date'],
  ['followUpDate', 'Follow-up date'],
]
export const WORKFLOW_LIMITS = { maxStatuses: 60, maxStatusLabel: 80, maxLabel: 30 } as const

export type { WorkflowLabels }

/** Only renamed values are kept; a blank name means the built-in one. */
export function cleanLabels(value: unknown): WorkflowLabels {
  const raw = value && typeof value === 'object' ? (value as any) : {}
  const pick = <K extends string>(keys: K[], source: any) => {
    const result: Partial<Record<K, string>> = {}
    for (const key of keys) {
      const label = String(source?.[key] ?? '')
        .trim()
        .slice(0, WORKFLOW_LIMITS.maxLabel)
      if (label && label !== key) result[key] = label
    }
    return result
  }
  const priority = pick(PRIORITIES, raw.priority)
  const health = pick(HEALTHS, raw.health)
  return {
    ...(Object.keys(priority).length ? { priority } : {}),
    ...(Object.keys(health).length ? { health } : {}),
  }
}

export const priorityLabel = (value: Priority, labels?: WorkflowLabels) => labels?.priority?.[value] || value
export const healthLabel = (value: Client['health'], labels?: WorkflowLabels) => labels?.health?.[value] || value

export interface WorkflowInput {
  statuses: unknown
  /** For each removed status still in use: the id of the status its tasks move to. */
  statusMoves?: Record<string, string>
  waitingOn?: unknown
  visibleColumns: unknown
  labels?: unknown
  /** Custom task fields (customFields.ts); kept as they are when not sent. */
  customFields?: unknown
}

type Item = { status?: unknown; waitingOn?: unknown; archived?: unknown; title?: unknown }

export type WorkflowPlan =
  | { ok: true; taskSettings: TaskSettings; items: any[]; renamedTasks: number; movedTasks: number }
  | { ok: false; error: string }

export function statusUsage(items: readonly Item[]) {
  const used = new Map<string, number>()
  for (const item of items) {
    const label = String(item?.status ?? '')
    if (label) used.set(label, (used.get(label) || 0) + 1)
  }
  return used
}

export function planWorkflowUpdate(
  current: TaskSettings | undefined,
  items: readonly Item[],
  input: WorkflowInput,
): WorkflowPlan {
  const fail = (error: string): WorkflowPlan => ({ ok: false, error })
  if (!Array.isArray(input?.statuses) || !input.statuses.length || input.statuses.length > WORKFLOW_LIMITS.maxStatuses)
    return fail(`Keep between 1 and ${WORKFLOW_LIMITS.maxStatuses} statuses.`)
  if (!Array.isArray(input.visibleColumns)) return fail('Choose the task columns to show.')
  const statuses: TaskStatusDefinition[] = input.statuses.map((raw: any) => ({
    id: String(raw?.id ?? '')
      .trim()
      .slice(0, 100),
    label: String(raw?.label ?? '').trim(),
    closed: Boolean(raw?.closed),
  }))
  if (statuses.some(status => !status.id || !status.label)) return fail('Every status needs a name.')
  if (statuses.some(status => status.label.length > WORKFLOW_LIMITS.maxStatusLabel))
    return fail(`Keep status names to ${WORKFLOW_LIMITS.maxStatusLabel} characters.`)
  if (new Set(statuses.map(status => status.id)).size !== statuses.length) return fail('Status IDs must be unique.')
  if (new Set(statuses.map(status => status.label.toLowerCase())).size !== statuses.length)
    return fail('Status names must be unique.')
  if (statuses.every(status => status.closed)) return fail('Keep at least one status that is not done.')
  if (!statuses.some(status => status.closed)) return fail('Keep at least one status that marks work as done.')
  const columns = TASK_COLUMNS.map(([key]) => key)
  if (input.visibleColumns.some((column: any) => !columns.includes(column))) return fail('Unknown task column.')

  // Renames follow the status id; removed statuses move their tasks where the Administrator said.
  const previous = current?.statuses || []
  const nextById = new Map(statuses.map(status => [status.id, status]))
  const nextLabels = new Set(statuses.map(status => status.label))
  const used = statusUsage(items)
  const relabel = new Map<string, string>()
  for (const status of previous) {
    const kept = nextById.get(status.id)
    if (kept) {
      if (kept.label !== status.label) relabel.set(status.label, kept.label)
      continue
    }
    const count = used.get(status.label) || 0
    if (!count) continue
    const target = nextById.get(String(input.statusMoves?.[status.id] ?? ''))
    if (!target)
      return fail(
        `“${status.label}” is used by ${count} task${count === 1 ? '' : 's'}. Choose where ${count === 1 ? 'it moves' : 'they move'} before removing it.`,
      )
    relabel.set(status.label, target.label)
  }
  for (const [label, count] of used) {
    if (!relabel.has(label) && !nextLabels.has(label))
      return fail(
        `${count} task${count === 1 ? ' uses' : 's use'} “${label}”, which is not in the list. Add it back or move them.`,
      )
  }

  // Archived work stays done: a status it uses cannot become open, and it cannot move to an open status.
  const closedAfter = (label: string) => statuses.find(status => status.label === label)?.closed
  for (const item of items) {
    if (item?.archived !== true) continue
    const label = String(item.status ?? '')
    const after = relabel.get(label) ?? label
    const wasClosed = previous.find(status => status.label === label)?.closed ?? true
    if (wasClosed && closedAfter(after) === false)
      return fail(
        `Archived tasks use “${label}”. Keep ${relabel.has(label) ? `“${after}”` : 'it'} marked as done, or reopen those tasks first.`,
      )
  }

  const waiting = planWaitingOnUpdate(
    input.waitingOn === undefined ? waitingOnOptions(current) : input.waitingOn,
    current,
    items as { waitingOn?: unknown }[],
  )
  if (!waiting.ok) return fail(waiting.error)

  let renamedTasks = 0
  let movedTasks = 0
  const removed = new Set(previous.filter(status => !nextById.has(status.id)).map(status => status.label))
  const nextItems = applyWaitingOnRenames(items as any[], waiting.update.renamed).map((item: any) => {
    const label = String(item?.status ?? '')
    const target = relabel.get(label)
    if (target === undefined) return item
    if (removed.has(label)) movedTasks++
    else renamedTasks++
    return { ...item, status: target }
  })
  renamedTasks += items.filter(item => waiting.update.renamed.has(String(item?.waitingOn ?? ''))).length
  const labels = cleanLabels(input.labels === undefined ? current?.labels : input.labels)
  // Custom task fields: kept as they were unless sent. Removing one hides its values on tasks (kept, not deleted).
  if (input.customFields !== undefined && !Array.isArray(input.customFields))
    return fail('Send the custom fields as a list.')
  const customFields = cleanFieldDefs(input.customFields === undefined ? current?.customFields : input.customFields)
  if (Array.isArray(input.customFields) && customFields.length < input.customFields.length)
    return fail('Every custom field needs a unique name, a type, and (for Choice) at least one option.')
  return {
    ok: true,
    taskSettings: {
      statuses,
      visibleColumns: [...new Set<TaskColumnKey>(['status', ...(input.visibleColumns as TaskColumnKey[])])],
      waitingOn: waiting.update.options,
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(customFields.length ? { customFields } : {}),
    },
    items: nextItems,
    renamedTasks,
    movedTasks,
  }
}
