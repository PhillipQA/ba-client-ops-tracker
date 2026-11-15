/**
 * Board view: each row is a card, and the cards stand in columns by one field (a Choice or a Person column).
 * Dragging a card to another column changes that field, the same as editing the cell.
 * Calendar view: rows on a month or week by one of their Date columns; dragging a row to another day changes the date.
 *
 * Pure functions, shared by the app and the tests.
 */
import type { Cell, OptionColor, TrackerColumn, TrackerRow } from './trackerModel'

// ---- board ----

/** Columns the board can stand its cards in. */
export const boardFields = (columns: TrackerColumn[]) =>
  columns.filter(column => column.type === 'select' || column.type === 'person')

/** The field the board uses: the one chosen if it still fits, else a Status-like Choice column, else the first. */
export function boardField(columns: TrackerColumn[], chosen: string): TrackerColumn | undefined {
  const fields = boardFields(columns)
  return (
    fields.find(column => column.id === chosen) ||
    fields.find(column => column.type === 'select' && /status|state|stage/i.test(column.name)) ||
    fields.find(column => column.type === 'select') ||
    fields[0]
  )
}

export type BoardLane = {
  /** The cell value a card dropped here gets ('' for the lane of rows with no value). */
  value: string
  label: string
  color?: OptionColor
  rows: TrackerRow[]
}

/**
 * The board's lanes, with their rows in the order given. A Choice column has one lane per option, in the option
 * order; a Person column one per person who has a row, by name.
 * Rows with no value, or a value that no longer exists, stand in a first lane of their own, shown when it has rows.
 */
export function boardLanes(field: TrackerColumn, rows: TrackerRow[], personName: (id: string) => string): BoardLane[] {
  const lanes: BoardLane[] =
    field.type === 'select'
      ? (field.options || []).map(option => ({ value: option.id, label: option.label, color: option.color, rows: [] }))
      : []
  const byValue = new Map(lanes.map(lane => [lane.value, lane]))
  const none: BoardLane = { value: '', label: field.type === 'person' ? 'Nobody' : `No ${field.name}`, rows: [] }
  for (const row of rows) {
    const cell = row.cells[field.id]
    const value = typeof cell === 'string' ? cell : ''
    let lane = value ? byValue.get(value) : none
    if (!lane && field.type === 'person' && value) {
      lane = { value, label: personName(value) || 'Unknown user', rows: [] }
      byValue.set(value, lane)
      lanes.push(lane)
    }
    ;(lane || none).rows.push(row)
  }
  if (field.type === 'person') lanes.sort((a, b) => a.label.localeCompare(b.label))
  return none.rows.length || !lanes.length ? [none, ...lanes] : lanes
}

/** The cell value for a card dropped on a lane. */
export const laneCell = (lane: Pick<BoardLane, 'value'>): Cell => lane.value

/** Up to three short facts for a card: the row's dates, people and choices, apart from the board's own field. */
export function cardFacts(
  row: TrackerRow,
  columns: TrackerColumn[],
  field: TrackerColumn,
  textOf: (column: TrackerColumn, row: TrackerRow) => string,
  count = 3,
): { name: string; text: string }[] {
  const order = ['date', 'task_due', 'person', 'task_owner', 'select', 'task_status', 'number']
  const titleId = columns.find(column => column.type === 'text')?.id
  return columns
    .filter(column => column.id !== field.id && column.id !== titleId && order.includes(column.type))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
    .map(column => ({ name: column.name, text: textOf(column, row) }))
    .filter(fact => fact.text)
    .slice(0, count)
}

// ---- calendar ----

/** Columns the calendar can place rows by. Only stored dates: a linked task's due date is changed on the task. */
export const calendarFields = (columns: TrackerColumn[]) => columns.filter(column => column.type === 'date')

/** The date column the calendar uses: the one chosen if it still fits, else one named like go-live or due, else the first. */
export function calendarField(columns: TrackerColumn[], chosen: string): TrackerColumn | undefined {
  const fields = calendarFields(columns)
  return (
    fields.find(column => column.id === chosen) ||
    fields.find(column => /go.?live|due|end|finish|target|deadline/i.test(column.name)) ||
    fields[0]
  )
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const isoOf = (date: Date) => date.toISOString().slice(0, 10)
export const addDays = (iso: string, days: number) => {
  const date = utc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return isoOf(date)
}
/** The Monday on or before a day: weeks start on Monday, like the Timeline. */
export const mondayOf = (iso: string) => addDays(iso, -((utc(iso).getUTCDay() + 6) % 7))

/** The days a month's calendar shows: whole weeks, Monday first, covering the month of the day given. */
export function monthDays(anchor: string): string[] {
  const first = `${anchor.slice(0, 7)}-01`
  const start = mondayOf(first)
  const next = utc(first)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const days: string[] = []
  for (let day = start; day < isoOf(next) || days.length % 7 !== 0; day = addDays(day, 1)) days.push(day)
  return days
}
/** The seven days of the week of the day given. */
export const weekDays = (anchor: string) =>
  Array.from({ length: 7 }, (_item, index) => addDays(mondayOf(anchor), index))

/** The same day one month (or week) earlier or later, kept inside the month it lands in. */
export function stepAnchor(anchor: string, mode: 'month' | 'week', by: number) {
  if (mode === 'week') return addDays(anchor, 7 * by)
  const date = utc(`${anchor.slice(0, 7)}-01`)
  date.setUTCMonth(date.getUTCMonth() + by)
  return isoOf(date)
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
/** "November 2026", or "Nov 9 – 15, 2026" for a week. */
export function calendarTitle(anchor: string, mode: 'month' | 'week') {
  const month = (iso: string) => MONTH_NAMES[Number(iso.slice(5, 7)) - 1]
  if (mode === 'month') return `${month(anchor)} ${anchor.slice(0, 4)}`
  const days = weekDays(anchor),
    first = days[0],
    last = days[6]
  const short = (iso: string) => `${month(iso).slice(0, 3)} ${Number(iso.slice(8))}`
  return first.slice(0, 7) === last.slice(0, 7)
    ? `${short(first)} – ${Number(last.slice(8))}, ${last.slice(0, 4)}`
    : `${short(first)} – ${short(last)}, ${last.slice(0, 4)}`
}

/** Rows by the day in their date column, and the rows with no date. */
export function rowsByDay(rows: TrackerRow[], field: TrackerColumn) {
  const byDay = new Map<string, TrackerRow[]>()
  const undated: TrackerRow[] = []
  for (const row of rows) {
    const cell = row.cells[field.id]
    const day = typeof cell === 'string' ? cell.slice(0, 10) : ''
    if (!ISO.test(day)) undated.push(row)
    else byDay.set(day, [...(byDay.get(day) || []), row])
  }
  return { byDay, undated }
}
