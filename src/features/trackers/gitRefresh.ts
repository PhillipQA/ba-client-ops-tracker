/**
 * When GIT Tracker rows are brought up to date with their tickets (gitFollow.ts), in the browser:
 * - once at sign-in, and once each time the app is loaded (a browser refresh) while signed in;
 * - after each successful GitLab or GitHub sync in Work Hub (the sign-in sync, or Sync);
 * - Refresh in a GIT Tracker (GitTicketsPanel).
 * Never on a timer. A refresh that changed rows is announced, so an open GIT Tracker loads them again.
 */
import type { AuthUser } from '../accounts/auth'
import { workHubSync } from '../work-hub/workHubSync'
import { type GitRefreshResult, gitTicketsApi } from './gitTicketsApi'

export const GIT_REFRESHED = 'git-tracker-refreshed'
const PROVIDERS = ['gitlab', 'github'] as const

let session = ''
let watching = false
const seen: Record<(typeof PROVIDERS)[number], number> = { gitlab: 0, github: 0 }

export function announceRefresh(result: GitRefreshResult) {
  if (!result.rows) return
  try {
    window.dispatchEvent(new CustomEvent<GitRefreshResult>(GIT_REFRESHED, { detail: result }))
  } catch {
    /* No window (tests). */
  }
}

/** Refreshes every GIT Tracker of the workspace; failures are quiet (the next sync tries again). */
export async function refreshGitTrackers(provider?: (typeof PROVIDERS)[number]) {
  try {
    const result = await gitTicketsApi.refreshAll(provider)
    announceRefresh(result)
    return result
  } catch {
    return null
  }
}

/** The person who is signed in (null when no one): a new sign-in or a fresh page load refreshes once. */
export function gitFollowSession(user: AuthUser | null) {
  const allowed = Boolean(
    user && user.status === 'Active' && user.accountType !== 'platform' && user.modules.includes('trackers'),
  )
  const next = allowed ? [user!.organizationId || '', user!.id, user!.lastLoginAt || ''].join('|') : ''
  if (next === session) return
  session = next
  if (!next) return
  watchWorkHub()
  void refreshGitTrackers()
}

/** After a GitLab or GitHub sync in Work Hub succeeds, refresh that provider's tickets. */
function watchWorkHub() {
  if (watching) return
  watching = true
  const snapshot = workHubSync.getSnapshot()
  for (const id of PROVIDERS) seen[id] = snapshot.integrations[id].revision
  workHubSync.subscribe(() => {
    const state = workHubSync.getSnapshot()
    for (const id of PROVIDERS) {
      const { phase, revision } = state.integrations[id]
      if (revision === seen[id]) continue
      const before = seen[id]
      seen[id] = revision
      if (session && phase === 'success' && revision > before) void refreshGitTrackers(id)
    }
  })
}
