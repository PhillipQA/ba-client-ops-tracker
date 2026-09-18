import type { ActivityLog, TaskEvidence, WorkItem } from './types'

export const TASK_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024

export type TaskEvidenceMutationResult = {
  item: WorkItem
  activity?: ActivityLog
  updatedAt?: string
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read the selected file.'))
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('Could not encode the selected file.'))
      else resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>
}

export async function uploadTaskEvidence(taskId: string, file: File): Promise<TaskEvidenceMutationResult> {
  if (file.size > TASK_EVIDENCE_MAX_BYTES) throw new Error('Evidence files must be 10 MB or smaller.')
  const dataBase64 = await fileToBase64(file)
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/evidence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      fileSize: file.size,
      dataBase64,
    }),
  })
  const body = await responseBody(response)
  if (!response.ok) throw new Error(String(body.error || 'Could not upload evidence.'))
  return body as unknown as TaskEvidenceMutationResult
}

export async function deleteTaskEvidence(taskId: string, evidenceId: string): Promise<TaskEvidenceMutationResult> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(evidenceId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  const body = await responseBody(response)
  if (!response.ok) throw new Error(String(body.error || 'Could not delete evidence.'))
  return body as unknown as TaskEvidenceMutationResult
}

export function taskEvidenceUrl(taskId: string, evidence: TaskEvidence) {
  return `/api/tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(evidence.id)}`
}
