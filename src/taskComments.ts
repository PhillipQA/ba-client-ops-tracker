import type { AppNotification, WorkItem } from './types'

export type TaskCommentMutationResult = {
  item: WorkItem
  notifications?: AppNotification[]
  updatedAt?: string
}

export async function addTaskComment(taskId: string, text: string): Promise<TaskCommentMutationResult> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ text }),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(String(body.error || 'Comment could not be saved.'))
  return body as unknown as TaskCommentMutationResult
}
