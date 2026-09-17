import type { Client, PlannerActivity, Priority, Project, WaitingOn, WorkItem } from './types'

export type AISuggestionKind = 'issue' | 'requirement' | 'follow_up' | 'activity' | 'draft_reply'

export interface AISuggestion {
  id: string
  kind: AISuggestionKind
  title: string
  rationale: string
  description?: string
  priority?: Priority
  waitingOn?: Exclude<WaitingOn, 'Done'>
  followUpDate?: string
  activityDate?: string
  activityTime?: string
  draft?: string
}

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  suggestions?: AISuggestion[]
}

export interface AssistantContext {
  client?: Client
  project?: Project
  openItems: WorkItem[]
  recentItems: WorkItem[]
  upcomingActivities: PlannerActivity[]
}

export async function askBAAssistant(args: {
  message: string
  context: AssistantContext
  history: AIMessage[]
}): Promise<{ message: string; suggestions: AISuggestion[] }> {
  const response = await fetch('/api/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })

  const body = await response.json().catch(() => null) as { error?: string; message?: string; suggestions?: AISuggestion[] } | null
  if (!response.ok) throw new Error(body?.error || 'AI assistant request failed.')
  if (!body?.message) throw new Error('AI assistant returned an empty response.')

  return { message: body.message, suggestions: body.suggestions ?? [] }
}
