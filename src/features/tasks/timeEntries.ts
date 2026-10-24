import type { TimeEntry, TimeEntryInput } from './effort'
import type { WorkItem } from '../../shared/types'
import { requestJson } from '../../shared/http'

export type TimeEntryMutationResult = {
  item: WorkItem
  entry: TimeEntry
  updatedAt?: string
}

const send = (url: string, method: 'POST' | 'DELETE', body?: unknown) =>
  requestJson<TimeEntryMutationResult>(url, {
    method,
    body,
    bare: true,
    fallback: 'The time entry could not be saved.',
  })

export function addTimeEntry(taskId: string, input: TimeEntryInput) {
  return send(`/api/tasks/${encodeURIComponent(taskId)}/time-entries`, 'POST', input)
}

export function deleteTimeEntry(taskId: string, entryId: string) {
  return send(`/api/tasks/${encodeURIComponent(taskId)}/time-entries/${encodeURIComponent(entryId)}`, 'DELETE')
}
