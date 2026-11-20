/** The GIT template a new one starts from (see GitTemplateRules). */
import type { GitGeneration, GitRowBlueprint, GitTicketField, GitValue, GitWorkMapping } from './gitGeneration'
import type { TrackerColumn } from './trackerModel'

/** A new GIT template's starting point: one Task row for the ticket, and Development and QA Subtasks under it. */
export function starterGitTemplate(): { columns: TrackerColumn[]; generation: GitGeneration } {
  const columns: TrackerColumn[] = [
    { id: 'c_ticket', name: 'Ticket', type: 'text' },
    { id: 'c_stage', name: 'Stage', type: 'text' },
    { id: 'c_link', name: 'Link', type: 'link' },
    { id: 'c_labels', name: 'Labels', type: 'text' },
    { id: 'c_due', name: 'Due', type: 'date' },
  ]
  const ticket = (field: GitTicketField): GitValue => ({ from: 'ticket', field })
  const fixed = (value: string): GitValue => ({ from: 'fixed', value })
  const mapping = (title: string): GitWorkMapping => ({ title, description: '{ticket.url}', due: { from: 'ticket' } })
  const stage = (key: string, name: string): GitRowBlueprint => ({
    key,
    name,
    cells: { c_ticket: ticket('title'), c_stage: fixed(name), c_link: ticket('url') },
    when: [],
    work: 'subtask',
    parentKey: 'ticket',
    task: mapping(`${name}: #{ticket.number} {ticket.title}`),
  })
  return {
    columns,
    generation: {
      version: 1,
      rows: [
        {
          key: 'ticket',
          name: 'Ticket',
          cells: {
            c_ticket: ticket('title'),
            c_stage: fixed('Ticket'),
            c_link: ticket('url'),
            c_labels: ticket('labels'),
            c_due: ticket('due'),
          },
          when: [],
          work: 'task',
          task: mapping('#{ticket.number} {ticket.title}'),
        },
        stage('dev', 'Development'),
        stage('qa', 'QA'),
      ],
      columnRules: [],
    },
  }
}
