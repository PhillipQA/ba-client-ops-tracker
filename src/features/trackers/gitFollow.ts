/**
 * GIT Tracker columns that fill themselves from the ticket, and follow it.
 *
 * - By header name: a column named after a ticket field (Title, Number, URL, Repository, Labels, Assignees, Author,
 *   Milestone, Due date, State, Description, and common other names for them) is filled with that field.
 * - Label groups: any other column takes its value from the ticket's label of the same name. A Priority column takes
 *   High from priority::high (GitLab's scoped labels), Priority: High or priority/high. When the ticket has two labels
 *   of the group, the first one is taken.
 * - A template row that fills a column itself (a fixed value or a ticket field) wins over both.
 *
 * Following: when GitLab or GitHub is synced (at sign-in, Sync in Work Hub, or Refresh in the GIT Tracker), every
 * followed cell of a ticket's rows is set to what the ticket says now, except cells a person changed by hand
 * (pinned). Pure functions, shared by the server and the tests.
 */
import {
  GIT_FILLABLE_TYPES,
  type GitRowBlueprint,
  type GitTicketField,
  type GitTicketSnapshot,
  resolveCell,
  ticketFits,
} from './gitGeneration'
import type { Cell, TrackerColumn } from './trackerModel'

/** Column names (as normalized by headerKey) that mean a ticket field. */
const HEADER_NAMES: Record<GitTicketField, string[]> = {
  title: ['title', 'ticket title', 'issue title', 'ticket name', 'issue name', 'summary'],
  number: ['number', 'ticket number', 'issue number', 'ticket no', 'issue no', 'ticket #', 'issue #', '#', 'iid'],
  url: ['url', 'ticket url', 'issue url', 'link', 'ticket link', 'issue link', 'gitlab link', 'github link'],
  repository: ['repository', 'repo', 'ticket repository', 'project path'],
  labels: ['labels', 'label', 'ticket labels', 'tags'],
  assignees: ['assignees', 'assignee', 'ticket assignee', 'ticket assignees', 'assigned to', 'developer'],
  author: ['author', 'ticket author', 'created by', 'opened by', 'reporter', 'reported by'],
  milestone: ['milestone', 'ticket milestone'],
  due: ['due date', 'due', 'ticket due date', 'ticket due', 'gitlab due date'],
  state: ['state', 'ticket state', 'issue state', 'open closed', 'ticket status', 'issue status'],
  body: ['description', 'body', 'ticket description', 'issue description', 'details'],
}

/** A column name as compared: lowercase, punctuation as spaces (but # kept), single spaces. */
export const headerKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const FIELD_OF = new Map<string, GitTicketField>(
  (Object.entries(HEADER_NAMES) as [GitTicketField, string[]][]).flatMap(([field, names]) =>
    names.map(name => [name, field] as [string, GitTicketField]),
  ),
)

/** The ticket field a column's name means, or null. */
export const headerField = (name: string): GitTicketField | null => FIELD_OF.get(headerKey(name)) || null

/** Columns that can fill themselves: stored values the person could type, not ones another feature manages. */
export const canFollow = (column: TrackerColumn) =>
  GIT_FILLABLE_TYPES.includes(column.type) &&
  !column.synced &&
  !column.autoDone &&
  !column.taskField &&
  column.type !== 'checkbox'

/** A label split into its group and value: priority::high, Priority: High, priority/high. */
export function labelParts(label: string): { group: string; value: string } | null {
  const match = /^(.+?)\s*(?:::|:|\/)\s*(.+)$/.exec(label.trim())
  if (!match) return null
  const group = headerKey(match[1])
  const value = match[2].trim()
  return group && value ? { group, value } : null
}

/** The value of the column's label group on this ticket: the first matching label's value, or null when none. */
export function labelGroupValue(column: TrackerColumn, labels: string[]): string | null {
  const group = headerKey(column.name)
  if (!group) return null
  for (const label of labels) {
    const parts = labelParts(label)
    if (parts && parts.group === group) return parts.value
  }
  return null
}

const optionFor = (column: TrackerColumn, value: string) => {
  const wanted = value.trim().toLowerCase()
  return column.options?.find(option => option.label.trim().toLowerCase() === wanted)?.id || ''
}

export type FollowSource = { field: GitTicketField } | { label: string }
export type FollowedCell = { value: Cell; source: FollowSource }
/** A label whose value is not one of its Choice column's options: left as it was, and reported. */
export type FollowNote = { columnId: string; text: string }

/**
 * The cells of one ticket row that follow the ticket: by header name, label groups, and the template row's own
 * ticket-field cells. Columns the template row fills with a fixed value are not followed (set once, then the
 * person's). A label group with no label on the ticket is left out: the column may not be a label group at all.
 */
export function followedCells(
  columns: TrackerColumn[],
  ticket: GitTicketSnapshot,
  blueprint?: Pick<GitRowBlueprint, 'cells'>,
): { cells: Record<string, FollowedCell>; notes: FollowNote[] } {
  const cells: Record<string, FollowedCell> = {}
  const notes: FollowNote[] = []
  const own = blueprint?.cells || {}
  for (const column of columns) {
    const set = own[column.id]
    if (set) {
      if (set.from === 'ticket')
        cells[column.id] = { value: resolveCell(column, set, ticket), source: { field: set.field } }
      continue
    }
    if (!canFollow(column)) continue
    const field = headerField(column.name)
    if (field) {
      if (ticketFits(column, field))
        cells[column.id] = { value: resolveCell(column, { from: 'ticket', field }, ticket), source: { field } }
      continue
    }
    const label = labelGroupValue(column, ticket.labels)
    if (label === null) continue
    if (column.type === 'select' || column.type === 'multiselect') {
      const id = optionFor(column, label)
      if (!id) {
        notes.push({ columnId: column.id, text: `${column.name}: “${label}” is not one of its choices.` })
        continue
      }
      cells[column.id] = { value: column.type === 'select' ? id : [id], source: { label } }
    } else if (column.type === 'number') {
      const number = Number(label)
      if (!Number.isFinite(number)) {
        notes.push({ columnId: column.id, text: `${column.name}: “${label}” is not a number.` })
        continue
      }
      cells[column.id] = { value: number, source: { label } }
    } else if (column.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) {
        notes.push({ columnId: column.id, text: `${column.name}: “${label}” is not a date.` })
        continue
      }
      cells[column.id] = { value: label, source: { label } }
    } else cells[column.id] = { value: label.slice(0, 1000), source: { label } }
  }
  return { cells, notes }
}

/** The values alone, for a new row (the template row's own cells are added over them). */
export const followedValues = (followed: Record<string, FollowedCell>) =>
  Object.fromEntries(Object.entries(followed).map(([id, cell]) => [id, cell.value])) as Record<string, Cell>

const same = (a: Cell | undefined, b: Cell | undefined) => {
  const empty = (value: Cell | undefined) =>
    value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length)
  if (empty(a) && empty(b)) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * What a refresh changes in one row: the followed cells whose value differs from the row's, except pinned ones.
 * Returns the new values and, for the history, each change.
 */
export function refreshPatch(
  data: Record<string, Cell>,
  followed: Record<string, FollowedCell>,
  pinned: readonly string[],
): { cells: Record<string, Cell>; changed: string[] } {
  const skip = new Set(pinned)
  const cells: Record<string, Cell> = {}
  const changed: string[] = []
  for (const [columnId, cell] of Object.entries(followed)) {
    if (skip.has(columnId) || same(data?.[columnId], cell.value)) continue
    cells[columnId] = cell.value
    changed.push(columnId)
  }
  return { cells, changed }
}

/** Pinned cells, as stored on a ticket entry: row id -> column ids. Anything malformed is dropped. */
export function cleanPins(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string[]> = {}
  for (const [rowId, columns] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (!Array.isArray(columns)) continue
    const ids = [...new Set(columns.filter((id): id is string => typeof id === 'string' && id.length <= 100))].slice(
      0,
      100,
    )
    if (ids.length) out[rowId] = ids
  }
  return out
}

/** Pins after a person changed these cells of a row by hand. */
export function addPins(pins: Record<string, string[]>, rowId: string, columnIds: string[]) {
  const next = cleanPins(pins)
  next[rowId] = [...new Set([...(next[rowId] || []), ...columnIds])].slice(0, 100)
  return next
}

/** Pins with these columns released (every column of every row when `columnIds` is 'all'). */
export function removePins(pins: Record<string, string[]>, columnIds: string[] | 'all') {
  if (columnIds === 'all') return {}
  const drop = new Set(columnIds)
  const next: Record<string, string[]> = {}
  for (const [rowId, ids] of Object.entries(cleanPins(pins))) {
    const kept = ids.filter(id => !drop.has(id))
    if (kept.length) next[rowId] = kept
  }
  return next
}

/** The pinned columns of an entry, once each, for the ticket list. */
export const pinnedColumns = (pins: Record<string, string[]>) => [...new Set(Object.values(cleanPins(pins)).flat())]
