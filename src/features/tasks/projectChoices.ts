/**
 * Projects to pick from, grouped From Seeds then Before Seeds, closed ones left out. Each Seeds project shows its
 * contract number and client, so typing either finds it. Picking the project first brings its client and, on a DRF,
 * its contract number. With a Seeds client already chosen, only that client's Seeds projects are offered.
 */
import type { Client, Project } from '../../shared/types'
import type { SearchChoice } from '../../shared/ui/SearchSelect'
import { isClosedProject } from './lifecycle'

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

export function projectChoices(
  projects: Project[],
  clients: Client[],
  clientId = '',
  placeholder = 'Select project',
  keepId = '',
): SearchChoice[] {
  const open = projects.filter(project => project.id === keepId || !isClosedProject(project)).sort(byName)
  const clientName = (id?: string) => clients.find(client => client.id === id)?.name || ''
  const seedsClient = clients.some(client => client.id === clientId && client.seedsId)
  const fromSeeds = open.filter(project => project.seedsId && (!seedsClient || project.clientId === clientId))
  const grouped = open.some(project => project.seedsId)
  return [
    { value: '', label: placeholder },
    ...fromSeeds.map(project => ({
      value: project.id,
      label: project.name,
      hint: [project.contractNumber, clientName(project.clientId)].filter(Boolean).join(' · '),
      group: 'From Seeds',
    })),
    ...open
      .filter(project => !project.seedsId)
      .map(project => ({
        value: project.id,
        label: project.name,
        hint: clientName(project.clientId) || undefined,
        group: grouped ? 'Before Seeds' : undefined,
      })),
  ]
}

/** The project's client, when the project names one: the client follows the project. */
export const clientOfProject = (projects: Project[], projectId: string) =>
  projects.find(project => project.id === projectId)?.clientId || ''

/** A task's project, or its parent task's for a subtask. */
export function projectOfTask(items: { id: string; projectId?: string; parentTaskId?: string }[], taskId: string) {
  const task = items.find(item => item.id === taskId)
  if (!task) return ''
  if (task.projectId) return task.projectId
  return items.find(item => item.id === task.parentTaskId)?.projectId || ''
}
