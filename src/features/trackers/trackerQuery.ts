import { evaluateFormula, linkToInput, type Cell, type TrackerColumn, type TrackerRow, type ViewFilter, type TrackerView } from './trackerModel'
import type { DocHubLink } from '../documents/dochub'
import type { UserAccount, WorkItem } from '../../shared/types'

/**
 * Reading a tracker: what a cell shows, and how rows are searched, filtered, sorted and grouped.
 * Connected columns are worked out here from the task a row is linked to, so they are always current
 * and nothing is stored for them.
 */
export type Tone = 'green' | 'blue' | 'amber' | 'red' | 'gray'
export type Shown = {
  text: string
  tone?: Tone
  /** For sorting: a number for numbers and checkboxes, otherwise text. */
  key: string | number
  /** A connected cell on a row with no task, or a task that is gone. */
  note?: 'unlinked' | 'removed' | 'formula-error'
}

export type Lookup = {
  task: (id: string) => WorkItem | undefined
  /** The task and its subtasks. */
  family: (id: string) => WorkItem[]
  person: (id: string) => string
  today: string
  /** The tracker's columns, so Calculated cells can read the columns they use. */
  columns?: TrackerColumn[]
}

export function makeLookup(items: WorkItem[], accounts: Pick<UserAccount, 'id' | 'name' | 'username'>[], today: string): Lookup {
  const byId = new Map(items.map(item => [item.id, item]))
  const children = new Map<string, WorkItem[]>()
  for (const item of items) if (item.parentTaskId) { const list = children.get(item.parentTaskId); if (list) list.push(item); else children.set(item.parentTaskId, [item]) }
  const people = new Map(accounts.map(account => [account.id, account.name || account.username || '']))
  return {
    task: id => byId.get(id),
    family: id => { const task = byId.get(id); return task ? [task, ...(children.get(id) || [])] : [] },
    person: id => people.get(id) || '',
    today,
  }
}

const DONE_TASK = /^(done|complete|completed|closed|resolved|cancelled|canceled)\b/i
const COMPLETE = new Set(['DONE', 'COMPLETE', 'COMPLETED'])
const VOIDED = new Set(['VOID', 'VOIDED'])
const NEEDS_ATTENTION = new Set(['REJECTED', 'EXPIRED', 'BOUNCE', 'ERROR', 'UNKNOWN', 'IMPORT_FAILED', 'UPLOAD_FAILED'])
const DRAFT = new Set(['PREPARING', 'SETUP_REQUIRED', 'READY_TO_REVIEW', 'UPLOADING', 'IMPORTING', 'UPLOADED', 'REVIEW_REQUIRED'])

/** One line for the DocHub sign-offs on a task and its subtasks. */
export function signoffSummary(family: WorkItem[]): Pick<Shown, 'text' | 'tone'> {
  const seen = new Set<string>(), docs: DocHubLink[] = []
  for (const item of family) for (const doc of item.docHubDocuments || []) if (!seen.has(doc.id)) { seen.add(doc.id); docs.push(doc) }
  const live = docs.filter(doc => !VOIDED.has(String(doc.status).toUpperCase()))
  if (!live.length) return { text: 'Not sent', tone: 'gray' }
  const status = (doc: DocHubLink) => String(doc.status).toUpperCase()
  if (live.every(doc => COMPLETE.has(status(doc)))) return { text: live.length === 1 ? 'Signed' : `All ${live.length} signed`, tone: 'green' }
  if (live.some(doc => NEEDS_ATTENTION.has(status(doc)))) return { text: 'Needs attention', tone: 'amber' }
  if (live.every(doc => DRAFT.has(status(doc)))) return { text: 'Draft, not sent', tone: 'gray' }
  const signed = live.reduce((sum, doc) => sum + (COMPLETE.has(status(doc)) ? doc.total : Math.min(doc.signed, doc.total)), 0), total = live.reduce((sum, doc) => sum + doc.total, 0)
  return { text: `${signed} of ${total} signed`, tone: 'blue' }
}

function connected(column: TrackerColumn, row: TrackerRow, lookup: Lookup): Shown {
  if (!row.taskId) return { text: '', key: '', note: 'unlinked' }
  const task = lookup.task(row.taskId)
  if (!task) return { text: '', key: '', note: 'removed' }
  switch (column.type) {
    case 'task_status': return { text: task.status || '', key: (task.status || '').toLowerCase(), tone: DONE_TASK.test(task.status || '') ? 'green' : 'gray' }
    case 'task_due': {
      const due = task.dueDate || ''
      return { text: due, key: due, tone: due && due < lookup.today && !DONE_TASK.test(task.status || '') ? 'red' : undefined }
    }
    case 'task_owner': {
      const name = (task.assignedToUserId && lookup.person(task.assignedToUserId)) || task.owner || ''
      return { text: name, key: name.toLowerCase() }
    }
    case 'signoff': { const summary = signoffSummary(lookup.family(row.taskId)); return { ...summary, key: summary.text.toLowerCase() } }
    case 'drive_files': {
      const seen = new Set<string>()
      for (const item of lookup.family(row.taskId)) for (const file of item.driveFiles || []) seen.add(file.id)
      return { text: seen.size === 0 ? 'No files' : seen.size === 1 ? '1 file' : `${seen.size} files`, key: seen.size, tone: seen.size ? 'blue' : 'gray' }
    }
    default: return { text: '', key: '' }
  }
}

export function shown(column: TrackerColumn, row: TrackerRow, lookup: Lookup): Shown {
  const value: Cell | undefined = row.cells[column.id]
  switch (column.type) {
    case 'link': { const text = typeof value === 'string' ? linkToInput(value) : ''; return { text, key: text.toLowerCase() } }
    case 'text': case 'longtext': { const text = typeof value === 'string' ? value : ''; return { text, key: text.toLowerCase() } }
    case 'number': return typeof value === 'number' ? { text: String(value), key: value } : { text: '', key: '' }
    case 'date': { const text = typeof value === 'string' ? value : ''; return { text, key: text } }
    case 'checkbox': return value === true ? { text: 'Yes', key: 1, tone: 'green' } : { text: 'No', key: 0 }
    case 'select': {
      const option = column.options?.find(item => item.id === value)
      return option ? { text: option.label, key: column.options!.indexOf(option) } : { text: '', key: '' }
    }
    case 'multiselect': {
      const labels = (Array.isArray(value) ? value : []).map(id => column.options?.find(item => item.id === id)?.label || '').filter(Boolean)
      return { text: labels.join(', '), key: labels.join(', ').toLowerCase() }
    }
    case 'person': { const id = typeof value === 'string' ? value : ''; const name = id ? lookup.person(id) || 'Unknown user' : ''; return { text: name, key: name.toLowerCase() } }
    case 'secret': return row.secretSet[column.id] ? { text: 'Set', key: 1 } : { text: '', key: '' }
    case 'formula': {
      const result = evaluateFormula(column, row.cells, lookup.columns || [column])
      if (result.error) return { text: result.error === 'Divide by 0' ? '#DIV/0' : '#ERROR', key: '', tone: 'red', note: 'formula-error' }
      return result.value === null ? { text: '', key: '' } : { text: String(result.value), key: result.value }
    }
    default: return connected(column, row, lookup)
  }
}

/** Rows that match a search box: every word must appear in some visible, non-secret column. */
export function searchRows(rows: TrackerRow[], columns: TrackerColumn[], query: string, lookup: Lookup, hidden: string[] = []) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  const searchable = columns.filter(column => column.type !== 'secret' && !hidden.includes(column.id))
  return rows.filter(row => {
    const text = searchable.map(column => shown(column, row, lookup).text).join('\n').toLowerCase()
    return words.every(word => text.includes(word))
  })
}

export function matchesFilter(column: TrackerColumn | undefined, row: TrackerRow, filter: ViewFilter, lookup: Lookup) {
  if (!column) return true
  const cell = shown(column, row, lookup), raw = row.cells[column.id], wanted = filter.value.trim().toLowerCase()
  const text = cell.text.toLowerCase()
  const empty = column.type === 'secret' ? !row.secretSet[column.id] : column.type === 'checkbox' ? raw !== true : cell.text === ''
  const equals = () => {
    if (column.type === 'select' || column.type === 'person') return raw === filter.value
    if (column.type === 'number') return typeof raw === 'number' && raw === Number(filter.value)
    if (column.type === 'date' || column.type === 'task_due') return cell.text === filter.value
    return text === wanted
  }
  switch (filter.op) {
    case 'contains': return !wanted || text.includes(wanted)
    case 'is': return equals()
    case 'is_not': return !equals()
    case 'is_empty': return empty
    case 'not_empty': return !empty
    case 'gt': return typeof raw === 'number' && filter.value.trim() !== '' && raw > Number(filter.value)
    case 'lt': return typeof raw === 'number' && filter.value.trim() !== '' && raw < Number(filter.value)
    case 'before': return Boolean(cell.text) && Boolean(filter.value) && cell.text < filter.value
    case 'after': return Boolean(cell.text) && Boolean(filter.value) && cell.text > filter.value
    case 'checked': return raw === true
    case 'unchecked': return raw !== true
    default: return true
  }
}

export function filterRows(rows: TrackerRow[], columns: TrackerColumn[], filters: ViewFilter[], lookup: Lookup) {
  if (!filters.length) return rows
  const byId = new Map(columns.map(column => [column.id, column]))
  return rows.filter(row => filters.every(filter => matchesFilter(byId.get(filter.columnId), row, filter, lookup)))
}

/** Empty values always sort last, whichever way the column is sorted. */
export function sortRows(rows: TrackerRow[], columns: TrackerColumn[], sort: TrackerView['sort'], lookup: Lookup) {
  if (!sort) return rows
  const column = columns.find(item => item.id === sort.columnId)
  if (!column) return rows
  const direction = sort.dir === 'desc' ? -1 : 1
  const keyed = rows.map((row, index) => ({ row, index, cell: shown(column, row, lookup) }))
  keyed.sort((a, b) => {
    const emptyA = a.cell.key === '' , emptyB = b.cell.key === ''
    if (emptyA || emptyB) return emptyA === emptyB ? a.index - b.index : emptyA ? 1 : -1
    const result = typeof a.cell.key === 'number' && typeof b.cell.key === 'number' ? a.cell.key - b.cell.key : String(a.cell.key).localeCompare(String(b.cell.key), 'en', { numeric: true })
    return result * direction || a.index - b.index
  })
  return keyed.map(item => item.row)
}

export type Group = { key: string; label: string; rows: TrackerRow[] }

/** Splits rows into groups by one column. Select groups follow the option order; others are alphabetical; empty comes last. */
export function groupRows(rows: TrackerRow[], column: TrackerColumn, lookup: Lookup): Group[] {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const cell = shown(column, row, lookup)
    const label = cell.text || ''
    const key = label.toLowerCase()
    const group = groups.get(key)
    if (group) group.rows.push(row); else groups.set(key, { key, label: label || 'Empty', rows: [row] })
  }
  const list = [...groups.values()]
  const order = column.type === 'select' ? (column.options || []).map(option => option.label.toLowerCase()) : null
  list.sort((a, b) => {
    if (a.key === '' || b.key === '') return a.key === b.key ? 0 : a.key === '' ? 1 : -1
    if (order) return order.indexOf(a.key) - order.indexOf(b.key)
    return a.label.localeCompare(b.label, 'en', { numeric: true })
  })
  return list
}

/** The search box, the active filters and the sort, applied in that order. */
export function visibleRows(rows: TrackerRow[], columns: TrackerColumn[], state: { search: string; filters: ViewFilter[]; sort: TrackerView['sort']; hidden?: string[] }, lookup: Lookup) {
  return sortRows(filterRows(searchRows(rows, columns, state.search, lookup, state.hidden), columns, state.filters, lookup), columns, state.sort, lookup)
}

/** The first Text column names a row in the detail panel and in messages. */
export function rowTitle(columns: TrackerColumn[], row: TrackerRow) {
  const column = columns.find(item => item.type === 'text')
  const value = column ? row.cells[column.id] : ''
  return typeof value === 'string' && value ? value : 'Untitled row'
}
