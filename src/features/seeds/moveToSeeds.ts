/**
 * Moving Before Seeds work into Seeds: a task goes, with its subtasks, to a Seeds project and that project's client
 * (the Seeds parent). It is the same task, so its comments, files, linked emails, time and tracker rows go with it.
 * Pure: the app applies the result to its store.
 */
import type { Project, WorkItem } from '../../shared/types'
import { isClosedProject } from '../tasks/lifecycle'
import { seedsTaskNamed } from '../../shared/seeds'

export type MoveSkip = { id: string; title: string; reason: string }
export type MoveResult = {
  items: WorkItem[]
  /** Top-level tasks moved. */
  moved: string[]
  /** Subtasks that went with them. */
  subtasks: number
  skipped: MoveSkip[]
}

/** Why a Seeds project cannot take moved work, or '' when it can. */
export function seedsTargetProblem(project?: Pick<Project, 'seedsId' | 'clientId' | 'archived' | 'seedsArchived'>) {
  if (!project?.seedsId) return 'Choose a Seeds project.'
  if (isClosedProject(project)) return 'That Seeds project is closed.'
  if (!project.clientId) return 'That Seeds project has no client in Seeds.'
  return ''
}

/**
 * Moves the given top-level tasks (a subtask id moves its whole task) and their subtasks to `project`. `seedsTaskId`
 * tags the moved tasks with one of the project's Seeds tasks; otherwise each task and subtask takes the Seeds task
 * whose name matches its title, if any. Archived tasks and tasks already there are skipped, with the reason.
 */
export function moveToSeeds(
  items: WorkItem[],
  input: { taskIds: string[]; project: Project; seedsTaskId?: string },
): MoveResult {
  const problem = seedsTargetProblem(input.project)
  if (problem) throw new Error(problem)
  const project = input.project
  const clientId = project.clientId as string
  const seedsTasks = (project.seedsTasks || []).filter(task => !task.archived)
  const chosen = input.seedsTaskId && seedsTasks.some(task => task.id === input.seedsTaskId) ? input.seedsTaskId : ''
  const byId = new Map(items.map(item => [item.id, item]))
  const skipped: MoveSkip[] = []
  const tops = new Set<string>()
  for (const id of input.taskIds) {
    const item = byId.get(id)
    if (!item) continue
    const top = item.parentTaskId ? byId.get(item.parentTaskId) : item
    if (!top || tops.has(top.id) || skipped.some(skip => skip.id === top.id)) continue
    if (top.archived) skipped.push({ id: top.id, title: top.title, reason: 'Archived: reopen it first.' })
    else if (top.projectId === project.id && top.clientId === clientId)
      skipped.push({ id: top.id, title: top.title, reason: 'Already in this project.' })
    else tops.add(top.id)
  }
  let subtasks = 0
  const tag = (item: WorkItem, seedsTaskId?: string): WorkItem => {
    const next: WorkItem = { ...item, clientId, projectId: project.id }
    // A Seeds task from the old project means nothing here.
    if (seedsTaskId) next.seedsTaskId = seedsTaskId
    else delete next.seedsTaskId
    return next
  }
  const moved = items.map(item => {
    if (tops.has(item.id)) return tag(item, chosen || seedsTaskNamed(seedsTasks, item.title))
    if (item.parentTaskId && tops.has(item.parentTaskId)) {
      subtasks++
      return tag(item, seedsTaskNamed(seedsTasks, item.title))
    }
    return item
  })
  return { items: moved, moved: [...tops], subtasks, skipped }
}

/** The tasks a Before Seeds project can move: its top-level tasks, archived ones last (they cannot move). */
export function projectTasksToMove(items: WorkItem[], projectId: string) {
  return items
    .filter(item => !item.parentTaskId && item.projectId === projectId)
    .sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || a.title.localeCompare(b.title))
}
