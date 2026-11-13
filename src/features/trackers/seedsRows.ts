/**
 * Trackers that follow Seeds: when a Seeds sync brings in a new project for one of a tracker's clients (a new store
 * for PCI, say), a tracker switched on for it ("Add new Seeds projects as rows") gets a row for that project, with its
 * task (and, on a Site rollout tracker, a subtask per step) in that project. New Seeds tasks change nothing here: they
 * stay a pick-list on subtasks and time.
 *
 * Pure functions, shared by the server (server/trackers/tracker-seeds-rows.ts) and the tests.
 */
import { isClosedProject } from '../tasks/lifecycle'
import { splitClientIds, type Cell, type TrackerColumn } from './trackerModel'

export type SeedsRowProject = { id: string; name: string; clientId: string; contractNumber?: string }

const text = (value: unknown) => (value == null ? '' : String(value))
const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])

/**
 * Projects a save added from Seeds: linked to Seeds, with a client, open, and not in the workspace before. A project
 * that was there already (renamed, reopened) is not new.
 */
export function newSeedsProjects(before: any, after: any): SeedsRowProject[] {
  const known = new Set(list(before?.projects).map(project => text(project?.id)))
  return list(after?.projects)
    .filter(
      project =>
        project?.id &&
        project.seedsId &&
        text(project.clientId) &&
        !known.has(text(project.id)) &&
        !project.beforeSeeds &&
        !isClosedProject(project),
    )
    .map(project => ({
      id: text(project.id),
      name: text(project.name).trim() || 'Seeds project',
      clientId: text(project.clientId),
      ...(text(project.contractNumber).trim() ? { contractNumber: text(project.contractNumber).trim() } : {}),
    }))
}

/** The stored tracker fields this needs (a tenant_trackers row). */
export type SeedsRowTracker = {
  client_id?: string
  project_id?: string
  archived_at?: string | null
  seeds_rows?: boolean
}

/** The new projects a tracker takes: it is switched on and not archived, and the project is for one of its clients. */
export function projectsForTracker(tracker: SeedsRowTracker, fresh: SeedsRowProject[]) {
  if (tracker.seeds_rows !== true || tracker.archived_at) return []
  const clients = new Set(splitClientIds(tracker.client_id))
  const own = new Set(splitClientIds(tracker.project_id))
  return fresh.filter(project => clients.has(project.clientId) && !own.has(project.id))
}

const BRANCH = /^branch$/i
const SITE = /^terminal\s*\/\s*site$/i
/**
 * Where a row's name goes: the Branch column (a Seeds project is usually a store), else Terminal/Site, else the first
 * plain Text column. None: the tracker has no column for a name, so it gets no rows from Seeds.
 */
export function nameColumn(columns: TrackerColumn[]) {
  const plain = columns.filter(column => column.type === 'text' && !column.taskField)
  return (
    plain.find(column => BRANCH.test(column.name.trim())) ||
    plain.find(column => SITE.test(column.name.trim())) ||
    plain[0]
  )
}

/** The new row's cells: the project's name, and its contract number when the tracker has a Contract number column. */
export function seedsRowCells(columns: TrackerColumn[], project: SeedsRowProject): Record<string, Cell> | null {
  const name = nameColumn(columns)
  if (!name) return null
  const cells: Record<string, Cell> = { [name.id]: project.name.slice(0, 500) }
  const contract = columns.find(column => column.taskField === 'contract')
  if (contract && project.contractNumber) cells[contract.id] = project.contractNumber.slice(0, 500)
  return cells
}
