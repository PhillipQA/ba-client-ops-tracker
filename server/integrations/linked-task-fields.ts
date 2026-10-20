import { IntegrationError } from './tenant-integrations'

export const LINKED_TASK_WAITING_ON = ['Me', 'Developer', 'Client', 'QA', 'Design', 'Done'] as const
export type LinkedTaskWaitingOn = typeof LINKED_TASK_WAITING_ON[number]
export type LinkedTaskSchedule = { waitingOn: LinkedTaskWaitingOn; startDate: string; dueDate: string; followUpDate: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/

function scheduleDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !DATE.test(value)) throw new IntegrationError(`Enter a valid ${label}.`)
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new IntegrationError(`Enter a valid ${label}.`)
  return value
}

/**
 * Reads the optional schedule and waiting-on fields submitted when a task is
 * created from a GitHub/GitLab ticket. Missing fields keep the previous
 * defaults (waiting on "Me", no dates) so older clients keep working.
 */
export function linkedTaskSchedule(body: any): LinkedTaskSchedule {
  const rawWaitingOn = body?.waitingOn
  if (rawWaitingOn !== undefined && rawWaitingOn !== '' && !LINKED_TASK_WAITING_ON.includes(rawWaitingOn)) throw new IntegrationError('Choose a valid waiting on value.')
  const waitingOn: LinkedTaskWaitingOn = rawWaitingOn ? rawWaitingOn : 'Me'
  const startDate = scheduleDate(body?.startDate, 'start date')
  const dueDate = scheduleDate(body?.dueDate, 'due date')
  const followUpDate = scheduleDate(body?.followUpDate, 'follow-up date')
  if (startDate && dueDate && dueDate < startDate) throw new IntegrationError('Due date cannot be earlier than start date.')
  return { waitingOn, startDate, dueDate, followUpDate }
}
