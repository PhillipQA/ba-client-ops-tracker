/**
 * A GitLab or GitHub ticket added to a GIT Tracker (GIT Tracker part 3), as the screens see it. The server makes these
 * (server/trackers/git-ticket-plan.ts); Work Hub and the GIT Tracker show them.
 */
export type GitEntryStatus = 'Pending' | 'Processing' | 'Completed' | 'Failed'
export type GitTicketEntry = {
  id: string
  trackerId: string
  provider: 'gitlab' | 'github'
  repository: string
  number: number
  title: string
  url: string
  clientId: string
  projectId: string
  status: GitEntryStatus
  error: string
  attempts: number
  addedBy: string
  addedByName: string
  addedAt: string
  updatedAt: string
  /** Its rows follow the ticket: refreshed at sign-in, Sync in Work Hub, and Refresh. On unless turned off. */
  follows: boolean
  /** Columns a person changed by hand in its rows, which a refresh leaves alone. */
  pinnedColumns: string[]
  /** When its rows were last compared with the ticket ('' when never). */
  refreshedAt: string
  /** The tracker rows it made (only in a tracker's ticket list). */
  rowIds?: string[]
  /** The tracker's name (only in a ticket's list of GIT Trackers). */
  trackerName?: string
  /** Tasks and Subtasks it made. */
  workCount?: number
}
