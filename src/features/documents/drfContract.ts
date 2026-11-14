/**
 * The DRF's Contract Number follows the Seeds project of the chosen task (or of the chosen project when no task is
 * picked). A number the app filled in follows the selection when it changes; a number the person typed is kept, with a
 * warning when it differs from Seeds. A number drafted from an email gives way to the Seeds one.
 */
import type { Project, WorkItem } from '../../shared/types'

/** Two contract numbers are the same when they differ only in case and spacing. */
export const sameContract = (a: string, b: string) =>
  a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()

/** The project whose contract the DRF uses: the task's, its parent task's, or the project picked on its own. */
export function drfContractProject(
  projects: Project[],
  items: WorkItem[],
  taskId: string,
  projectId = '',
): Project | undefined {
  const task = taskId ? items.find(item => item.id === taskId) : undefined
  const parent = task?.parentTaskId ? items.find(item => item.id === task.parentTaskId) : undefined
  const id = task ? task.projectId || parent?.projectId || '' : projectId
  return id ? projects.find(project => project.id === id) : undefined
}

/**
 * The field's next value when the selection's Seeds contract changes. `auto` is the value the app last filled in (from
 * Seeds or from an email draft): while the field still holds it, the field follows the selection. A number the person
 * typed stays. With no Seeds number, an email's number comes back; another project's Seeds number is cleared.
 */
export function nextContract(
  current: string,
  auto: string,
  seeds: string,
  fromEmail = '',
): { value: string; auto: string } {
  const untouched = !current.trim() || current === auto
  if (!untouched) return { value: current, auto }
  if (seeds) return { value: seeds, auto: seeds }
  if (fromEmail) return { value: fromEmail, auto: fromEmail }
  return { value: '', auto: '' }
}

export type ContractHint = { tone: 'ok' | 'warn' | 'info'; text: string; useSeeds?: string }

/** The line under the field: where the number came from, or why it may be wrong. */
export function contractHint(input: {
  value: string
  project?: Project
  fromEmail?: string
}): ContractHint | undefined {
  const { value, project, fromEmail = '' } = input
  if (!project) return undefined
  const seeds = String(project.contractNumber || '').trim()
  const typed = value.trim()
  if (!seeds)
    return typed
      ? { tone: 'info', text: `Seeds has no contract number for ${project.name}; check this one by hand.` }
      : { tone: 'info', text: `Seeds has no contract number for ${project.name}.` }
  if (!typed) return { tone: 'warn', text: `Seeds has ${seeds} for ${project.name}.`, useSeeds: seeds }
  if (!sameContract(typed, seeds))
    return {
      tone: 'warn',
      text: `This differs from the Seeds contract number for ${project.name} (${seeds}).`,
      useSeeds: seeds,
    }
  const emailNote = fromEmail && !sameContract(fromEmail, seeds) ? ` The email said ${fromEmail}.` : ''
  return { tone: 'ok', text: `From Seeds: ${project.name}.${emailNote}` }
}
