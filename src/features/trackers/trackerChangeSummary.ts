/**
 * One line for a tracker history record, for the Action Center's "Recent tracker changes". Kinds that are private
 * (Secret values set or revealed) or personal (snoozed reminders) are not listed at all.
 */
// sheet_comment and sheet_out are cell comments kept with the Google Sheet (tracker-sheet-comments.ts), not changes.
export const HIDDEN_CHANGE_KINDS = ['secrets', 'reveal', 'snooze', 'sheet_comment', 'sheet_out']

const quote = (value: unknown) => {
  const text = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  const short = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return short ? `“${short}”` : 'empty'
}

export function changeSummary(kind: string, detail: any, name: (id: string) => string = id => id): string {
  const d = detail && typeof detail === 'object' ? detail : {}
  switch (kind) {
    case 'row_created':
      return 'added the row'
    case 'cells': {
      const cells: any[] = Array.isArray(d.cells) ? d.cells : []
      const first = cells[0]
      if (!first) return 'changed the row'
      const to = first.person && first.to ? name(String(first.to)) : first.to
      const more = cells.length > 1 ? ` and ${cells.length - 1} more` : ''
      return `set ${first.name || 'a cell'} to ${quote(to)}${more}`
    }
    case 'git_follow': {
      const cells: any[] = Array.isArray(d.cells) ? d.cells : []
      const first = cells[0]
      const from = d.provider === 'github' ? 'GitHub' : 'GitLab'
      if (!first) return `updated the row from ${from}`
      const more = cells.length > 1 ? ` and ${cells.length - 1} more` : ''
      return `updated ${first.name || 'a cell'} to ${quote(first.to)}${more} from ${from}`
    }
    case 'comment':
      return `commented: ${quote(d.text)}`
    case 'task_linked':
      return `linked the task ${quote(d.title || 'Untitled')}`
    case 'task_unlinked':
      return 'unlinked the task'
    case 'subtask_linked':
      return `linked ${quote(d.title || 'a task')}`
    case 'subtask_unlinked':
      return 'removed a task link'
    case 'auto_done':
      return d.to
        ? `${d.name || 'Done'} set to ${quote(d.to)} by its tasks`
        : `${d.name || 'Done'} cleared by its tasks`
    case 'automation': {
      const done = Array.isArray(d.done) && d.done.length ? d.done.join(', ') : 'nothing to do'
      return `automation: ${done}`
    }
    case 'auto_done_sheet_failed':
      return 'could not update the connected Sheet'
    default:
      return kind.replace(/_/g, ' ')
  }
}
