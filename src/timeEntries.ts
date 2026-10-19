import type { TimeEntry, TimeEntryInput } from './effort'
import type { WorkItem } from './types'

export type TimeEntryMutationResult = {
  item: WorkItem
  entry: TimeEntry
  updatedAt?: string
}

async function send(url: string, method: 'POST' | 'DELETE', body?: unknown): Promise<TimeEntryMutationResult> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(String(result.error || 'The time entry could not be saved.'))
  return result as unknown as TimeEntryMutationResult
}

export function addTimeEntry(taskId: string, input: TimeEntryInput) {
  return send(`/api/tasks/${encodeURIComponent(taskId)}/time-entries`, 'POST', input)
}

export function deleteTimeEntry(taskId: string, entryId: string) {
  return send(`/api/tasks/${encodeURIComponent(taskId)}/time-entries/${encodeURIComponent(entryId)}`, 'DELETE')
}
