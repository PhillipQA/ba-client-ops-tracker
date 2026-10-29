/**
 * Making a new Google Sheet from a tracker. Pure functions: the server sends what they return to the Sheets API, and
 * tests check them. The Sheet gets one tab with a header row, the tracker's rows in order, a dropdown for each Choice
 * column, a checkbox for each Checkbox column and dates as real dates, so it syncs back exactly like a Sheet that
 * was connected by hand.
 */
import { isBasicType, linkToInput, type Cell, type TrackerColumn } from './trackerModel'
import { sheetRowKeys } from './trackerSync'

/** Days from Google Sheets' day 0 (30 December 1899) to 1 January 1970. */
const SHEETS_EPOCH = 25569
const ISO = /^(\d{4})-(\d{2})-(\d{2})/

type CellData = {
  userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean }
}
export type SheetPlan = {
  headers: string[]
  /** The header of the column that names each row: the first Text column. */
  keyHeader: string
  /** Sheet header → tracker column id, for the connection. */
  headerMap: Record<string, string>
  /** Header row first. */
  rowData: { values: CellData[] }[]
  /** Which tracker rows went to the Sheet, in order, with the key each will be recognised by. */
  placed: { rowId: string; key: string }[]
  /** Rows with nothing in any column the Sheet holds: left out, as a sync skips empty Sheet rows. */
  skipped: number
  dropdowns: { index: number; options: string[] }[]
  checkboxes: number[]
  dates: number[]
}

/** The text a person sees for a cell, as written to the Sheet. */
function textOf(column: TrackerColumn, value: Cell | undefined, people: Map<string, string>): string {
  if (value === undefined || value === null) return ''
  switch (column.type) {
    case 'select':
      return column.options?.find(option => option.id === value)?.label || ''
    case 'multiselect':
      return (Array.isArray(value) ? value : [])
        .map(id => column.options?.find(option => option.id === id)?.label || '')
        .filter(Boolean)
        .join(', ')
    case 'person':
      return typeof value === 'string' ? people.get(value) || '' : ''
    case 'link':
      return typeof value === 'string' ? linkToInput(value) : ''
    case 'checkbox':
      return value === true ? 'TRUE' : ''
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

function cellOf(column: TrackerColumn, value: Cell | undefined, people: Map<string, string>): CellData {
  if (column.type === 'checkbox') return { userEnteredValue: { boolValue: value === true } }
  if (column.type === 'number' && typeof value === 'number' && Number.isFinite(value))
    return { userEnteredValue: { numberValue: value } }
  if (column.type === 'date' && typeof value === 'string') {
    const match = ISO.exec(value)
    if (match) {
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000
      return { userEnteredValue: { numberValue: day + SHEETS_EPOCH } }
    }
  }
  const text = textOf(column, value, people)
  // stringValue is always kept as text, so a value such as "=5" or "00123" is not turned into a formula or number.
  return text ? { userEnteredValue: { stringValue: text } } : {}
}

/**
 * What a new Sheet holds for a tracker. Only basic columns go to the Sheet (text, number, date, checkbox, choice,
 * person, link); Secret, Calculated and task columns stay in the tracker. The first Text column names the rows.
 */
export function sheetFromTracker(
  columns: TrackerColumn[],
  rows: { id: string; cells: Record<string, Cell> }[],
  people: { id: string; name: string }[],
): SheetPlan | { error: string } {
  const shown = columns.filter(column => isBasicType(column.type))
  const key = shown.find(column => column.type === 'text')
  if (!key) return { error: 'The tracker needs a Text column to name each row in the Sheet, such as Task or Branch.' }
  // The key column goes first, as people expect in a sheet; the rest keep the tracker's order.
  const ordered = [key, ...shown.filter(column => column.id !== key.id)]
  const names = new Map(people.map(person => [person.id, person.name]))
  const headers = ordered.map(column => column.name)

  const kept = rows.filter(row =>
    ordered.some(column => {
      if (column.type === 'checkbox') return row.cells[column.id] === true
      return textOf(column, row.cells[column.id], names).trim() !== ''
    }),
  )
  const keys = sheetRowKeys(kept.map(row => textOf(key, row.cells[key.id], names)))
  return {
    headers,
    keyHeader: key.name,
    headerMap: Object.fromEntries(ordered.map(column => [column.name, column.id])),
    rowData: [
      { values: headers.map(header => ({ userEnteredValue: { stringValue: header } })) },
      ...kept.map(row => ({ values: ordered.map(column => cellOf(column, row.cells[column.id], names)) })),
    ],
    placed: kept.map((row, at) => ({ rowId: row.id, key: keys[at] })),
    skipped: rows.length - kept.length,
    dropdowns: ordered.flatMap((column, index) =>
      column.type === 'select' && column.options?.length
        ? [{ index, options: column.options.map(option => option.label) }]
        : [],
    ),
    checkboxes: ordered.flatMap((column, index) => (column.type === 'checkbox' ? [index] : [])),
    dates: ordered.flatMap((column, index) => (column.type === 'date' ? [index] : [])),
  }
}

/**
 * The formatting requests sent after the Sheet is made: a bold, frozen header, dropdowns and checkboxes down the whole
 * column (so rows added later get them too), dates shown as YYYY-MM-DD and columns sized to fit.
 */
export function sheetFormatRequests(plan: SheetPlan, sheetId: number, rowCount: number) {
  const column = (index: number) => ({
    sheetId,
    startRowIndex: 1,
    endRowIndex: rowCount,
    startColumnIndex: index,
    endColumnIndex: index + 1,
  })
  return [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    ...plan.dropdowns.map(item => ({
      setDataValidation: {
        range: column(item.index),
        rule: {
          condition: { type: 'ONE_OF_LIST', values: item.options.map(option => ({ userEnteredValue: option })) },
          strict: false,
          showCustomUi: true,
        },
      },
    })),
    ...plan.checkboxes.map(index => ({
      setDataValidation: { range: column(index), rule: { condition: { type: 'BOOLEAN' } } },
    })),
    ...plan.dates.map(index => ({
      repeatCell: {
        range: column(index),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    })),
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: plan.headers.length },
      },
    },
  ]
}
