import { IntegrationError } from './tenant-integrations'
import { defaultWaitingOn, waitingOnOptions } from '../../src/waitingOn'

export type LinkedTaskSchedule = { waitingOn: string; startDate: string; dueDate: string; followUpDate: string }

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
 * created from a GitHub/GitLab ticket. Waiting on must be one of the
 * account's configured options. Missing fields keep the previous defaults
 * (the first open waiting-on option, no dates) so older clients keep working.
 */
export function linkedTaskSchedule(body: any, state?: any): LinkedTaskSchedule {
  const rawWaitingOn = body?.waitingOn
  const allowed = new Set(waitingOnOptions(state?.taskSettings).map((option) => option.label))
  if (rawWaitingOn !== undefined && rawWaitingOn !== '' && (typeof rawWaitingOn !== 'string' || !allowed.has(rawWaitingOn))) throw new IntegrationError('Choose a valid waiting on value.')
  const waitingOn = rawWaitingOn ? rawWaitingOn : defaultWaitingOn(state?.taskSettings)
  const startDate = scheduleDate(body?.startDate, 'start date')
  const dueDate = scheduleDate(body?.dueDate, 'due date')
  const followUpDate = scheduleDate(body?.followUpDate, 'follow-up date')
  if (startDate && dueDate && dueDate < startDate) throw new IntegrationError('Due date cannot be earlier than start date.')
  return { waitingOn, startDate, dueDate, followUpDate }
}
