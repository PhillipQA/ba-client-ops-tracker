/**
 * The totals row: one summary per column, worked out over the rows shown (after search and filters). Which summary a
 * column shows is kept on the column (`total`), so everyone on the tracker sees the same. Also the tracker's progress:
 * the share of rows that are done, for the bar in the tracker list.
 *
 * Pure functions, shared by the app, the server and the tests.
 */
import { autoDoneColumn, autoDoneValues } from './trackerAutoDone'
import { type Cell, evaluateFormula, TOTAL_KINDS, type TotalKind, type TrackerColumn } from './trackerModel'

export type { TotalKind }

export const TOTAL_LABELS: Record<TotalKind, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Smallest',
  max: 'Largest',
  filled: 'Filled',
  empty: 'Empty',
  checked: 'Ticked',
  options: 'Count by value',
  range: 'Earliest – latest',
}

/** The summaries a column can show, the most useful first. Protected columns have none. */
export const totalKindsFor = (column: Pick<TrackerColumn, 'type'>): TotalKind[] => TOTAL_KINDS[column.type] || []

type RowLike = { cells: Record<string, Cell> }
export type TotalShown = { label: string; text: string; title: string }

const round = (value: number) => Math.round(value * 1e10) / 1e10
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 2 })
const percent = (part: number, whole: number) => (whole ? Math.round((part * 100) / whole) : 0)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (iso: string) => {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number)
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${day}, ${year}` : iso
}

/**
 * What a column's totals cell shows for the rows given. `textOf` gives a cell's words as the grid shows them (an
 * option's label, a person's name, a linked task's status), so connected columns count the same way as plain ones.
 */
export function totalOf(
  column: TrackerColumn,
  kind: TotalKind,
  rows: RowLike[],
  columns: TrackerColumn[],
  textOf: (row: RowLike) => string,
): TotalShown {
  const label = TOTAL_LABELS[kind]
  const count = rows.length
  const of = `${count} row${count === 1 ? '' : 's'} shown`
  const numbers = () =>
    rows
      .map(row =>
        column.type === 'formula' ? evaluateFormula(column, row.cells, columns).value : row.cells[column.id],
      )
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  // A checkbox is always Yes or No, so "filled" means words to show for every other type.
  const filled = () =>
    rows.filter(row => (column.type === 'checkbox' ? row.cells[column.id] === true : textOf(row) !== ''))
  switch (kind) {
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      const values = numbers()
      if (!values.length) return { label, text: '—', title: `No numbers in ${column.name} for the ${of}` }
      const sum = values.reduce((total, value) => total + value, 0)
      const value =
        kind === 'sum'
          ? sum
          : kind === 'avg'
            ? sum / values.length
            : kind === 'min'
              ? Math.min(...values)
              : Math.max(...values)
      return { label, text: format.format(round(value)), title: `${label} of ${column.name} for the ${of}` }
    }
    case 'filled': {
      const has = filled().length
      return { label, text: `${has} of ${count}`, title: `${has} of the ${of} have a ${column.name}` }
    }
    case 'empty': {
      const none = count - filled().length
      return { label, text: `${none} of ${count}`, title: `${none} of the ${of} have no ${column.name}` }
    }
    case 'checked': {
      const ticked = rows.filter(row => row.cells[column.id] === true).length
      return {
        label,
        text: `${ticked} of ${count} · ${percent(ticked, count)}%`,
        title: `${ticked} of the ${of} are ticked in ${column.name}`,
      }
    }
    case 'options': {
      const counts = new Map<string, number>()
      for (const row of rows) {
        // A row with several values (Multiple choice) counts once for each.
        const words =
          column.type === 'multiselect' ? textOf(row).split(', ').filter(Boolean) : [textOf(row)].filter(Boolean)
        for (const word of words) counts.set(word, (counts.get(word) || 0) + 1)
      }
      // In the order the options are listed; values that are not options (people, statuses) by how common they are.
      const order = new Map((column.options || []).map((option, index) => [option.label, index]))
      const sorted = [...counts].sort(
        (a, b) => (order.get(a[0]) ?? 1e6) - (order.get(b[0]) ?? 1e6) || b[1] - a[1] || a[0].localeCompare(b[0]),
      )
      const all = sorted.map(([word, total]) => `${total} ${word}`)
      return {
        label: '',
        text: all.length ? all.slice(0, 4).join(' · ') + (all.length > 4 ? ` · +${all.length - 4}` : '') : '—',
        title: all.length ? `${column.name} for the ${of}: ${all.join(', ')}` : `No ${column.name} in the ${of}`,
      }
    }
    case 'range': {
      const dates = rows
        .map(row => textOf(row).slice(0, 10))
        .filter(text => /^\d{4}-\d{2}-\d{2}$/.test(text))
        .sort()
      if (!dates.length) return { label: '', text: '—', title: `No dates in ${column.name} for the ${of}` }
      const first = dates[0],
        last = dates[dates.length - 1]
      return {
        label: '',
        text: first === last ? shortDate(first) : `${shortDate(first)} – ${shortDate(last)}`,
        title: `Earliest and latest ${column.name} for the ${of}`,
      }
    }
  }
}

// ---- progress: how much of a tracker is done ----

const DONE_WORDS = /^(done|completed?|finished|closed|live|resolved|signed off)$/i

/**
 * The column that says a row is done, and the cell value that means done:
 * the "done when its tasks are done" column if the tracker has one, else a Choice column named like Status with an
 * option such as Done, Completed or Live. Undefined when the tracker has neither.
 */
export function progressColumn(columns: TrackerColumn[]): { column: TrackerColumn; done: string | true } | undefined {
  const auto = autoDoneColumn(columns)
  if (auto) {
    const { done } = autoDoneValues(auto)
    if (done === true) return { column: auto, done: true }
    if (typeof done === 'string' && done) return { column: auto, done }
  }
  const choices = columns.filter(column => column.type === 'select')
  for (const column of [...choices.filter(item => /status|state|stage/i.test(item.name)), ...choices]) {
    const option = column.options?.find(item => DONE_WORDS.test(item.label.trim()))
    if (option) return { column, done: option.id }
  }
  return undefined
}

/** Done rows out of all rows, or undefined when the tracker has no column that says done. */
export function progressOf(columns: TrackerColumn[], rows: RowLike[]) {
  const progress = progressColumn(columns)
  if (!progress) return undefined
  const done = rows.filter(row => row.cells[progress.column.id] === progress.done).length
  return { done, total: rows.length, percent: percent(done, rows.length), column: progress.column }
}

/** "5 of 12 done · 42%", for the tracker list. */
export function progressLabel(done: number, total: number) {
  return total ? `${done} of ${total} done · ${percent(done, total)}%` : 'No rows yet'
}
