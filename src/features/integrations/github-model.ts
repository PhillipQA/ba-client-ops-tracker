export const GITHUB_QA_STATUSES = ['Not started', 'In progress', 'Needs retest', 'Passed', 'Failed', 'Blocked'] as const
export type GithubQaStatus = (typeof GITHUB_QA_STATUSES)[number]
export type GithubRepository = { fullName: string; clientId: string; projectId: string }
export type GithubConnection = {
  connected: boolean
  encryptionReady: boolean
  login: string
  repositories: GithubRepository[]
  lastSyncedAt: string | null
  hasMore: boolean
  baseUrl?: string
}
export type GithubTicket = {
  id: string
  github_id?: number
  gitlab_id?: number
  number: number
  repository: string
  title: string
  body: string
  html_url: string
  state: 'open' | 'closed'
  state_reason: string | null
  creator: string
  assignees: string[]
  labels: string[]
  milestone: string
  comments_count: number
  created_at: string
  updated_at: string
  created_by_me: boolean
  assigned_to_me: boolean
  /** GitLab: the person commented on the issue. */
  commented_by_me?: boolean
  /** GitLab: YYYY-MM-DD, or null. */
  due_date?: string | null
  /** GitLab: more about the issue (see gitlabDetails.ts). */
  details?: GitlabTicketDetails
  qa_status: GithubQaStatus
  linked_task_id: string | null
}
export type GitlabTicketDetails = {
  weight?: number
  timeEstimate?: number
  timeSpent?: number
  tasksDone?: number
  tasksTotal?: number
  confidential?: boolean
  iteration?: string
  mergeRequests?: number
  type?: string
  severity?: string
  closedAt?: string
  closedBy?: string
}
export type GithubComment = { author: string; body: string; updatedAt: string; url: string }
export type GithubSyncResult = {
  imported: number
  updated: number
  requests: number
  hasMore: boolean
  retryAfterSeconds?: number
  lastSyncedAt?: string
}

export const WORK_HUB_TABS = [
  { id: 'Gmail', label: 'Email' },
  { id: 'Discord', label: 'Discord' },
  { id: 'GitHub', label: 'GitHub / GitLab' },
  { id: 'Manual', label: 'Manual Logs' },
] as const
