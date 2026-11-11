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

export type AISuggestionKind =
  | 'issue'
  | 'requirement'
  | 'follow_up'
  | 'activity'
  | 'draft_reply'
  | 'email_document'
  | 'tracker_draft'

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
