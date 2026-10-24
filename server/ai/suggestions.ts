// Cleaning up task suggestions the AI returns.
import { openWaitingOnOptions } from '../../src/features/tasks/waitingOn'

const allowedKinds = new Set(['issue', 'requirement', 'follow_up', 'activity', 'draft_reply'])

export const allowedPriorities = new Set(['Low', 'Medium', 'High', 'Urgent'])

// AI may only propose the account's open waiting-on options; completion stays a human action.
export function allowedWaitingOn(taskSettings: unknown) {
  return new Set(openWaitingOnOptions(taskSettings as any).map((option) => option.label))
}

export function sanitizeSuggestions(value: unknown, taskSettings?: unknown) {
  if (!Array.isArray(value)) return []
  const allowedWaiting = allowedWaitingOn(taskSettings)
  return value.slice(0, 5).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    if (!allowedKinds.has(String(item.kind)) || !String(item.title || '').trim()) return []
    return [{
      id: String(item.id || crypto.randomUUID()),
      kind: String(item.kind),
      title: String(item.title).slice(0, 180),
      rationale: String(item.rationale || '').slice(0, 600),
      description: item.description ? String(item.description).slice(0, 1200) : undefined,
      priority: allowedPriorities.has(String(item.priority)) ? String(item.priority) : undefined,
      waitingOn: allowedWaiting.has(String(item.waitingOn)) ? String(item.waitingOn) : undefined,
      followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.followUpDate || '')) ? String(item.followUpDate) : undefined,
      activityDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.activityDate || '')) ? String(item.activityDate) : undefined,
      activityTime: /^\d{2}:\d{2}$/.test(String(item.activityTime || '')) ? String(item.activityTime) : undefined,
      draft: item.draft ? String(item.draft).slice(0, 3000) : undefined,
    }]
  })
}

export function parseModelJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(cleaned) as Record<string, unknown> } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    throw new Error('The model did not return valid JSON.')
  }
}
