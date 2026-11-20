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

/**
 * Tasks of a tracker (and their subtasks) with no client, under a project with no client of its own, get the tracker's
 * client when it has exactly one. Seeds syncs before B109 took the client off such tasks; with several clients on the
 * tracker nothing is guessed. Only fills in a missing client, never replaces one.
 */
export function missingClientPatches(
  tracker: Pick<Tracker, 'clientId' | 'clientIds'>,
  taskIds: string[],
  items: { id: string; clientId?: string; projectId?: string; parentTaskId?: string }[],
  projects: { id: string; clientId?: string }[],
) {
  const clients = trackerClientIds(tracker)
  if (clients.length !== 1) return []
  const linked = new Set(taskIds)
  const ownClient = (projectId?: string) => Boolean(projectId && projects.find(p => p.id === projectId)?.clientId)
  return items
    .filter(item => linked.has(item.id) || Boolean(item.parentTaskId && linked.has(item.parentTaskId)))
    .filter(item => !item.clientId && !ownClient(item.projectId))
    .map(item => ({ id: item.id, clientId: clients[0] }))
}

/** A project a row's Project chip offers: one of the tracker's projects. */
export type RowProjectChoice = {
  id: string
  name: string
  contractNumber: string
  clientName: string
  /** The tracker's default project (★): rows with no task and no contract number go there. */
  isDefault: boolean
  /** Completed in Seeds or archived: existing tasks may be moved there, but it takes no new tasks. */
  completed: boolean
}

/** The tracker's projects for the Project chip, the default first, then by name. */
export function trackerProjectChoices<P extends ContractProject>(
  tracker: Pick<Tracker, 'projectId' | 'projectIds'>,
  projects: P[],
  clients: { id: string; name: string }[],
): RowProjectChoice[] {
  const ids = trackerProjectIds(tracker)
  const fallback = ids[0] || ''
  const defaultId = tracker.projectId && ids.includes(tracker.projectId) ? tracker.projectId : fallback
  return ids
    .flatMap(id => {
      const project = projects.find(item => item.id === id)
      if (!project) return []
      return [
        {
          id,
          name: project.name || 'Unnamed project',
          contractNumber: project.contractNumber?.trim() || '',
          clientName: clients.find(client => client.id === project.clientId)?.name || '',
          isDefault: id === defaultId,
          completed: isClosedProject(project),
        },
      ]
    })
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
    )
}

/**
 * What a row's Project chip shows. A row's own task can be moved to another project; a row whose task is a subtask
 * follows its parent task; a row with no task shows where its task will go (rowPlace), marked auto.
 */
export type RowProjectView =
  | { kind: 'task'; projectId: string; taskId: string; subtasks: number }
  | { kind: 'subtask'; projectId: string; parentTitle: string }
  | { kind: 'none'; projectId: string }

type ViewItem = {
  id: string
  title?: string
  projectId?: string
  clientId?: string
  parentTaskId?: string
  archived?: boolean
}

export function rowProjectView<P extends ContractProject>(
  tracker: Pick<Tracker, 'projectId' | 'projectIds' | 'clientId' | 'clientIds' | 'columns'>,
  row: Pick<TrackerRow, 'cells' | 'taskId'>,
  projects: P[],
  items: ViewItem[],
): RowProjectView {
  const task = row.taskId ? items.find(item => item.id === row.taskId) : undefined
  if (task?.parentTaskId) {
    const parent = items.find(item => item.id === task.parentTaskId)
    return { kind: 'subtask', projectId: task.projectId || parent?.projectId || '', parentTitle: parent?.title || '' }
  }
  if (task)
    return {
      kind: 'task',
      projectId: task.projectId || '',
      taskId: task.id,
      subtasks: items.filter(item => item.parentTaskId === task.id && !item.archived).length,
    }
  return { kind: 'none', projectId: rowPlace(tracker, { cells: row.cells, taskId: '' }, projects, items).projectId }
}

/** The project name a Project column cell keeps, for search, filters and sorting: its task's project's name. */
export function rowProjectName<P extends ContractProject>(
  row: Pick<TrackerRow, 'taskId'>,
  projects: P[],
  items: { id: string; projectId?: string; parentTaskId?: string }[],
): string {
  if (!row.taskId) return ''
  const task = items.find(item => item.id === row.taskId)
  if (!task) return ''
  const projectId = task.projectId || items.find(item => item.id === task.parentTaskId)?.projectId
  return (projectId && projects.find(project => project.id === projectId)?.name?.trim()) || ''
}

type MovableItem = {
  id: string
  projectId?: string
  clientId?: string
  parentTaskId?: string
  archived?: boolean
  seedsTaskId?: string
}

/**
 * Moves tasks (and their subtasks) to another project. Only top-level tasks move: a subtask among them is skipped, as
 * it follows its parent. The client becomes the project's own (its Seeds parent) when it has one; a project shared by
 * several clients keeps each task's client. A Seeds task (Go Live, Meetings…) is kept only if the new project has it.
 */
export function planProjectMove<T extends MovableItem>(
  items: T[],
  taskIds: string[],
  project: { id: string; clientId?: string; seedsTasks?: { id: string }[] },
): { items: T[]; moved: T[]; tasks: number; subtasks: number; skipped: number } {
  const wanted = [...new Set(taskIds)]
  const seedsTasks = new Set((project.seedsTasks || []).map(task => task.id))
  const movable = new Set(
    wanted.filter(id => {
      const item = items.find(entry => entry.id === id)
      return Boolean(item && !item.archived && !item.parentTaskId && item.projectId !== project.id)
    }),
  )
  let tasks = 0,
    subtasks = 0
  const moved: T[] = []
  const next = items.map(item => {
    const own = movable.has(item.id)
    const under = Boolean(item.parentTaskId && movable.has(item.parentTaskId))
    if (!own && !under) return item
    if (own) tasks += 1
    else subtasks += 1
    const { seedsTaskId, ...rest } = item
    const keep = Boolean(seedsTaskId && seedsTasks.has(seedsTaskId))
    const copy = {
      ...(keep ? item : rest),
      projectId: project.id,
      clientId: project.clientId || item.clientId,
    } as T
    moved.push(copy)
    return copy
  })
  return { items: next, moved, tasks, subtasks, skipped: wanted.length - movable.size }
}
