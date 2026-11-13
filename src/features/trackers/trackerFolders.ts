/**
 * Tracker folders. Every active person has a folder, made from the account's people (nothing is stored, so a new
 * person has one from the start). A folder holds the trackers that person is a user of:
 *
 * - the tracker's creator,
 * - everyone assigned to one of its projects (Seeds, or an Administrator's assignments before Seeds),
 * - people its creator or an Administrator added by hand (`members`).
 *
 * A tracker with several users shows in each of their folders; it is the same tracker, not a copy. Folders only ever
 * list trackers the viewer may open (the server filters the list), so a private tracker shows only to its creator.
 *
 * Pure functions, shared by the server (working out users) and the browser (folders and their contents).
 */
import { activeAssignments } from '../../shared/access'
import { splitClientIds, type Tracker } from './trackerModel'
import { asList as list } from '../../shared/lists'

/** At most this many people can be added by hand to one tracker. */
export const TRACKER_MEMBERS = 50

type Account = { id: string; name?: string; username?: string; status?: string }

const activeAccounts = (state: any): Account[] =>
  list(state?.accounts).filter(account => account?.id && account.status !== 'Disabled')

/** For each project: the active people assigned to it. Worked out once for a whole list of trackers. */
export function projectUsers(state: any): Map<string, Set<string>> {
  const byProject = new Map<string, Set<string>>()
  for (const account of activeAccounts(state))
    for (const assignment of activeAssignments(state, String(account.id))) {
      if (!assignment.projectId) continue
      const people = byProject.get(assignment.projectId) || new Set<string>()
      people.add(String(account.id))
      byProject.set(assignment.projectId, people)
    }
  return byProject
}

/** The people added to a tracker by hand, as stored: unique ids, without its creator. */
export function cleanMembers(value: unknown, createdBy = ''): string[] {
  return [...new Set(list(value).map(id => String(id ?? '').trim()))]
    .filter(id => id && id !== createdBy)
    .slice(0, TRACKER_MEMBERS)
}

/** Check people added by hand before saving: each must be an active person on this account. */
export function validateMembers(
  state: any,
  value: unknown,
  createdBy: string,
): { ok: true; members: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'Choose the people to add.' }
  if (value.length > TRACKER_MEMBERS + 1)
    return { ok: false, error: `A tracker can have at most ${TRACKER_MEMBERS} people added.` }
  const members = cleanMembers(value, createdBy)
  const active = new Set(activeAccounts(state).map(account => String(account.id)))
  if (members.some(id => !active.has(id))) return { ok: false, error: 'Choose active people on this account.' }
  return { ok: true, members }
}

/**
 * A tracker's users: its creator, the people on its projects, then the people added by hand. Only active people,
 * except the creator, who always keeps the tracker in their folder.
 */
export function trackerUsers(
  row: { created_by?: string; project_id?: unknown; members?: unknown },
  state: any,
  onProjects: Map<string, Set<string>> = projectUsers(state),
): string[] {
  const createdBy = String(row.created_by || '')
  const active = new Set(activeAccounts(state).map(account => String(account.id)))
  const users = new Set<string>(createdBy ? [createdBy] : [])
  for (const projectId of splitClientIds(row.project_id))
    for (const id of onProjects.get(projectId) || []) users.add(id)
  for (const id of cleanMembers(row.members, createdBy)) if (active.has(id)) users.add(id)
  return [...users]
}

/** Who a tracker counts as a user of, as the browser has it (older servers send no `users`: just the creator). */
export const usersOf = (tracker: Pick<Tracker, 'createdBy' | 'users'>) =>
  tracker.users?.length ? tracker.users : tracker.createdBy ? [tracker.createdBy] : []

/** Why someone is a user of a tracker, for the Users list in its details. */
export function userReason(
  tracker: Pick<Tracker, 'createdBy' | 'members'>,
  userId: string,
): 'creator' | 'added' | 'project' {
  if (userId === tracker.createdBy) return 'creator'
  return (tracker.members || []).includes(userId) ? 'added' : 'project'
}

export type TrackerFolder = { userId: string; name: string; count: number; mine: boolean }

/**
 * One folder per active person (the viewer's first, then by name), with how many of the given trackers are in it.
 * Someone no longer active keeps no folder; their trackers are still under All trackers.
 */
export function trackerFolders(accounts: Account[], trackers: Tracker[], viewerId: string): TrackerFolder[] {
  const counts = new Map<string, number>()
  for (const tracker of trackers) for (const id of usersOf(tracker)) counts.set(id, (counts.get(id) || 0) + 1)
  return accounts
    .filter(account => account?.id && account.status !== 'Disabled')
    .map(account => ({
      userId: account.id,
      name: account.name || account.username || 'Unnamed person',
      count: counts.get(account.id) || 0,
      mine: account.id === viewerId,
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name))
}

/** The trackers in one person's folder. */
export const trackersInFolder = (trackers: Tracker[], userId: string) =>
  trackers.filter(tracker => usersOf(tracker).includes(userId))
