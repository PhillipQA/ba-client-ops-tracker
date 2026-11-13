/**
 * Which project a tracker row is for. A tracker can follow several projects of its clients (each Seeds project has its
 * own contract), so a row goes to its task's project, else to the project whose contract number is in the row's
 * Contract number column (for example "SLSS #"), else to the tracker's default (first) project.
 */
import { isClosedProject } from '../tasks/lifecycle'
import { taskFieldColumn, trackerClientIds, trackerProjectIds, type Tracker, type TrackerRow } from './trackerModel'
import { cellText } from './trackerTasks'

export type ContractProject = {
  id: string
  name?: string
  clientId?: string
  contractNumber?: string
  archived?: boolean
  seedsArchived?: boolean
}

/** Contract numbers compared without case, spaces or punctuation: "SLSS-2024 001" matches "slss2024001". */
export const contractKey = (value: unknown) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/**
 * The project a contract number names: one of the tracker's projects first, then an open project of one of its
 * clients. Undefined when nothing matches, or when two projects share the number.
 */
export function projectForContract<P extends ContractProject>(
  tracker: Pick<Tracker, 'projectId' | 'projectIds' | 'clientId' | 'clientIds'>,
  contract: unknown,
  projects: P[],
): P | undefined {
  const key = contractKey(contract)
  if (!key) return undefined
  const matches = (list: P[]) => {
    const found = list.filter(project => contractKey(project.contractNumber) === key)
    return found.length === 1 ? found[0] : undefined
  }
  const own = new Set(trackerProjectIds(tracker))
  // New work only: a project completed in Seeds stays on the tracker but takes no new tasks.
  const mine = matches(projects.filter(project => own.has(project.id) && !isClosedProject(project)))
  if (mine) return mine
  const clients = new Set(trackerClientIds(tracker))
  return matches(
    projects.filter(project => project.clientId && clients.has(project.clientId) && !isClosedProject(project)),
  )
}

/**
 * The project and client a row's new task goes to. The row's task's project wins, then its contract number, then the
 * tracker's default project. The client is the project's own (the Seeds parent) when it has one.
 */
export function rowPlace<P extends ContractProject>(
  tracker: Pick<Tracker, 'projectId' | 'projectIds' | 'clientId' | 'clientIds' | 'columns'>,
  row: Pick<TrackerRow, 'cells' | 'taskId'>,
  projects: P[],
  items: { id: string; projectId?: string; clientId?: string }[] = [],
): { projectId: string; clientId: string; byContract: boolean } {
  const task = row.taskId ? items.find(item => item.id === row.taskId) : undefined
  const column = taskFieldColumn(tracker.columns, 'contract')
  const byContract =
    !task?.projectId && column
      ? projectForContract(tracker, cellText(column, row.cells[column.id]), projects)
      : undefined
  // The tracker's first open project: one completed in Seeds stays on the tracker but takes no new tasks.
  const open = trackerProjectIds(tracker).find(id => !isClosedProject(projects.find(project => project.id === id)))
  const projectId = task?.projectId || byContract?.id || open || ''
  const project = projects.find(item => item.id === projectId)
  return {
    projectId,
    clientId: task?.clientId || project?.clientId || trackerClientIds(tracker)[0] || '',
    byContract: Boolean(byContract),
  }
}

/** The contract number a row should show: its task's project's, when that project has one. */
export function rowContract<P extends ContractProject>(
  row: Pick<TrackerRow, 'taskId'>,
  projects: P[],
  items: { id: string; projectId?: string }[],
): string {
  if (!row.taskId) return ''
  const projectId = items.find(item => item.id === row.taskId)?.projectId
  return (projectId && projects.find(project => project.id === projectId)?.contractNumber?.trim()) || ''
}
