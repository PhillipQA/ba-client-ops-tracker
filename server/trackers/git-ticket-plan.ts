/**
 * GIT Tracker part 3, the pure parts: a Work Hub ticket as generation reads it, the Tasks still to make for a ticket
 * entry, and how entries are shown. No server dependencies, so they are easy to test.
 */
import type { GitPlan, GitTicketSnapshot } from '../../src/features/trackers/gitGeneration'
import type { TaskDraft } from '../../src/features/trackers/TrackerWork'

export type GitProvider = 'gitlab' | 'github'
export const GITHUB_INSTANCE = 'https://github.com'

/** Rows a ticket entry made carry this source key, so they can be found, filtered by client and removed with it. */
export const GIT_SOURCE_PREFIX = 'git:'
export const gitSourceKey = (entryId: string) => `${GIT_SOURCE_PREFIX}${entryId}`
export const entryIdOfSourceKey = (key: unknown) =>
  typeof key === 'string' && key.startsWith(GIT_SOURCE_PREFIX) ? key.slice(GIT_SOURCE_PREFIX.length) : ''

/** A Processing entry older than this is taken to have been cut off (a restart), and may be retried. */
export const STALE_PROCESSING_MS = 5 * 60_000

const strings = (value: unknown) =>
  (Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 100)

/** YYYY-MM-DD, also from a date sent as a full timestamp; '' when there is none. */
export function dayOf(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}/.exec(String(value ?? '').trim())?.[0] || ''
}

/** A ticket row from Work Hub (user_gitlab_issues or user_github_issues) as generation reads it. */
export function ticketSnapshot(provider: GitProvider, issue: any): GitTicketSnapshot {
  return {
    provider,
    repository: String(issue?.repository || ''),
    number: Number(issue?.number) || 0,
    title: String(issue?.title || ''),
    body: String(issue?.body || ''),
    url: String(issue?.html_url || ''),
    state: issue?.state === 'closed' ? 'closed' : 'open',
    labels: strings(issue?.labels),
    assignees: strings(issue?.assignees),
    author: String(issue?.creator || ''),
    milestone: String(issue?.milestone || ''),
    dueDate: provider === 'gitlab' ? dayOf(issue?.due_date) || null : null,
  }
}

/** The provider's stable id of the ticket, and of its repository (null until a sync has read it). */
export function issueIds(provider: GitProvider, issue: any) {
  const issueId = Number(provider === 'gitlab' ? issue?.gitlab_id : issue?.github_id)
  const repositoryId = Number(issue?.repository_id)
  return {
    issueId: Number.isSafeInteger(issueId) && issueId > 0 ? issueId : 0,
    repositoryId: Number.isSafeInteger(repositoryId) && repositoryId > 0 ? repositoryId : 0,
  }
}

/**
 * The repository mapping for a ticket: by the repository's stable id, else (before a sync has read the id) by its
 * path, case-insensitive. Only active mappings of the same provider and instance count.
 */
export function mappingForTicket(
  mappings: { provider: string; instance_url: string; repository_id: unknown; repository_path: string }[],
  ticket: { provider: GitProvider; instanceUrl: string; repositoryId: number; repository: string },
) {
  const same = mappings.filter(
    mapping => mapping.provider === ticket.provider && mapping.instance_url === ticket.instanceUrl,
  )
  if (ticket.repositoryId) {
    const byId = same.find(mapping => Number(mapping.repository_id) === ticket.repositoryId)
    if (byId) return byId
  }
  const path = ticket.repository.trim().toLowerCase()
  return same.find(mapping => String(mapping.repository_path || '').toLowerCase() === path) || null
}

/**
 * The Tasks and Subtasks of a plan that the workspace does not have yet, as drafts for tasksFromDrafts, with the ids
 * they must get (in the same order). A Subtask whose Task is made in the same batch points at it by index; one whose
 * Task exists already (an earlier attempt) points at it by id.
 */
export function missingWork(plan: Pick<GitPlan, 'work'>, existing: Set<string>) {
  const missing = plan.work.filter(work => !existing.has(work.id))
  const indexOf = new Map(missing.map((work, index) => [work.id, index]))
  const drafts: TaskDraft[] = missing.map(work => {
    const draft: TaskDraft = {
      title: work.title,
      clientId: work.clientId,
      projectId: work.projectId,
      ...(work.dueDate ? { dueDate: work.dueDate } : {}),
      ...(work.description ? { description: work.description } : {}),
      ...(work.assignedToUserId ? { assignedToUserId: work.assignedToUserId } : {}),
    }
    if (work.parentId) {
      const index = indexOf.get(work.parentId)
      if (index !== undefined) draft.parentIndex = index
      else draft.parentTaskId = work.parentId
    }
    return draft
  })
  return { drafts, ids: missing.map(work => work.id) }
}

/** newId for tasksFromDrafts: the planned ids first, in order, then fresh ones (for the activity entries). */
export function plannedIds(ids: string[], fresh: () => string) {
  let at = 0
  return () => (at < ids.length ? ids[at++] : fresh())
}

import type { GitEntryStatus, GitTicketEntry } from '../../src/features/trackers/gitTicketModel'
export type { GitEntryStatus, GitTicketEntry }

const STATUSES: GitEntryStatus[] = ['Pending', 'Processing', 'Completed', 'Failed']

export function entryOut(row: any): GitTicketEntry {
  return {
    id: String(row.id),
    trackerId: String(row.tracker_id),
    provider: row.provider === 'github' ? 'github' : 'gitlab',
    repository: String(row.repository_path || ''),
    number: Number(row.issue_number) || 0,
    title: String(row.title_snapshot || ''),
    url: String(row.issue_url || ''),
    clientId: String(row.client_id || ''),
    projectId: String(row.project_id || ''),
    status: STATUSES.includes(row.generation_status) ? row.generation_status : 'Pending',
    error: String(row.generation_error || ''),
    attempts: Number(row.attempts) || 0,
    addedBy: String(row.added_by || ''),
    addedByName: String(row.added_by_name || ''),
    addedAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

/** Whether an entry may be (re)generated now: never once Completed, and not while another attempt is running. */
export function canGenerate(entry: { status: GitEntryStatus; updatedAt: string }, now: number) {
  if (entry.status === 'Completed') return false
  if (entry.status !== 'Processing') return true
  const at = Date.parse(entry.updatedAt)
  return !Number.isFinite(at) || now - at >= STALE_PROCESSING_MS
}

/** A failure as the person reads it: one line, not too long. */
export const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error || 'Something went wrong.'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'Something went wrong.'
