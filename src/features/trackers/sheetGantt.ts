/**
 * A "Gantt chart" tab for a Google Sheet that a tracker follows, laid out like the project schedule template: month
 * and year, week, day and weekday across the top; phase headings ("1 Project Planning") in bold on a grey band with
 * their tasks under them; Start and End as dates, % Done as a percentage, Remarks coloured; and bars drawn by
 * conditional formatting that fill in by % done.
 *
 * The tab holds plain values, so anyone with the Sheet (a client, say) can edit it: Lead, Start, End, % Done and
 * Remarks. A hidden column keeps, for each task row, its key in the synced tab and the values last written. On every
 * sync the server compares the tab with those values; what was changed is written to the synced tab, the sync brings it
 * into the tracker, and the tab is then written again from the synced tab. Pure functions: the server sends what they
 * return to the Sheets API, and tests check them.
 */
import { settleTimelineFields, type TimelineSettings } from './timelineModel'
import type { TrackerColumn } from './trackerModel'
import { sheetRowKeys, tabRange } from './trackerSync'

export const GANTT_TAB = 'Gantt chart'

/** The synced tab's headers for each part of the chart. Only `task` and `start` are required. */
export type GanttFields = {
  wbs?: string
  task: string
  phase?: string
  lead?: string
  start: string
  end?: string
  progress?: string
  status?: string
  /** The Status column's choices, offered as a dropdown in the tab. */
  statusOptions?: string[]
}

/** A, B, … Z, AA, AB… for a 0-based column index. */
export function columnLetter(index: number) {
  let n = index + 1,
    out = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    out = String.fromCharCode(65 + rest) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const rgb = (hex: string) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
})
/** The colours of the project schedule template. */
const COLORS = {
  bar: '#2e75b6',
  planned: '#bdd7ee',
  late: '#f4cccc',
  today: '#fde2e2',
  todayHead: '#e06666',
  weekend: '#f3f3f3',
  head: '#f3f3f3',
  band: '#efefef',
  phase: '#d9d9d9',
  dates: '#dce6f1',
  doneStatus: '#ffc000',
  ongoingStatus: '#d9d9d9',
  fullDone: '#b6d7a8',
}

/** Rows above the tasks: title, controls, hint and month, week, day, and weekday with the column headers. */
export const HEAD_ROWS = 6
/** Days from Google Sheets' day 0 (30 December 1899) to 1 January 1970. */
const SHEETS_EPOCH = 25569

// ---- what the tab shows ----

type FieldKey = 'wbs' | 'task' | 'phase' | 'lead' | 'start' | 'end' | 'progress' | 'status'
/** Columns a person may change in the tab; the rest are written again on the next sync. */
export const EDITABLE: FieldKey[] = ['lead', 'start', 'end', 'progress', 'status']
type Left = { key: FieldKey | 'snap' | 'days'; header: string; width: number }
export type GanttLayout = { left: Left[]; source: Record<FieldKey, number>; fields: GanttFields }

/** Which columns the tab has, and where each one's values are in the synced tab. */
export function ganttLayout(headers: string[], fields: GanttFields): GanttLayout | { error: string } {
  const at = (header?: string) =>
    header
      ? headers.findIndex(
          item =>
            String(item ?? '')
              .trim()
              .toLowerCase() === header.trim().toLowerCase(),
        )
      : -1
  const source: Record<FieldKey, number> = {
    wbs: at(fields.wbs),
    task: at(fields.task),
    phase: at(fields.phase),
    lead: at(fields.lead),
    start: at(fields.start),
    end: at(fields.end),
    progress: at(fields.progress),
    status: at(fields.status),
  }
  if (source.task < 0) return { error: 'The Sheet has no column that names each task, so there is nothing to chart.' }
  if (source.start < 0) return { error: 'The Sheet has no Start date column, so there is nothing to chart.' }
  const left: Left[] = []
  if (source.wbs >= 0) left.push({ key: 'wbs', header: 'WBS', width: 50 })
  left.push({ key: 'task', header: 'TASK', width: 320 })
  if (source.lead >= 0) left.push({ key: 'lead', header: 'LEAD', width: 140 })
  left.push({ key: 'start', header: 'START', width: 95 })
  if (source.end >= 0) left.push({ key: 'end', header: 'END', width: 95 })
  if (source.progress >= 0) left.push({ key: 'progress', header: '% DONE', width: 70 })
  if (source.status >= 0) left.push({ key: 'status', header: 'REMARKS', width: 95 })
  left.push({ key: 'snap', header: '', width: 20 })
  left.push({ key: 'days', header: 'DAYS', width: 55 })
  return { left, source, fields }
}

type Raw = string | number | boolean | null | undefined
const isBlank = (value: Raw) => value === undefined || value === null || String(value).trim() === ''
const asNumber = (value: Raw) =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))
      ? Number(value)
      : null
/** Whether two cell values are the same, as a person would see them (numbers within rounding, text trimmed). */
export function sameValue(a: Raw, b: Raw) {
  if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b)
  const x = asNumber(a),
    y = asNumber(b)
  if (x !== null && y !== null) return Math.abs(x - y) < 1e-6
  return String(a).trim() === String(b).trim()
}

/** How the synced tab keeps % done: 0–1 when every value is at most 1 (how Excel keeps 90%), else 0–100. */
function progressScale(layout: GanttLayout, body: Raw[][]) {
  const at = layout.source.progress
  const numbers = at < 0 ? [] : body.map(line => asNumber(line[at])).filter((value): value is number => value !== null)
  const fractions = numbers.every(value => value >= 0 && value <= 1)
  return {
    /** Divide by this to show a fraction. */
    shown: fractions ? 1 : 100,
    /** Multiply a fraction by this to write it back; an empty or all-zero column takes 0–100, as the tracker does. */
    written: fractions && numbers.some(value => value > 0) ? 1 : 100,
  }
}

/** The synced tab's rows that a sync reads (not empty), with the key each is recognised by and its row number. */
function keyedLines(layout: GanttLayout, grid: Raw[][]) {
  const [, ...body] = grid
  const lines = body
    .map((line, at) => ({ line: Array.isArray(line) ? line : [], row: at + 2 }))
    .filter(entry => entry.line.some(value => !isBlank(value)))
  const keys = sheetRowKeys(lines.map(entry => String(entry.line[layout.source.task] ?? '')))
  return lines.map((entry, at) => ({ ...entry, key: keys[at] }))
}

type CellData = { userEnteredValue?: Record<string, unknown> }
const cell = (value: Raw): CellData =>
  isBlank(value)
    ? {}
    : typeof value === 'number'
      ? { userEnteredValue: { numberValue: value } }
      : typeof value === 'boolean'
        ? { userEnteredValue: { boolValue: value } }
        : { userEnteredValue: { stringValue: String(value) } }

/**
 * The tab's rows from the synced tab (header row first, read unformatted with dates as serial numbers): a heading row
 * per phase, in the order phases first appear, with its tasks under it; tasks with no phase last. Each task row ends
 * with its snapshot (hidden) and a Days formula.
 */
export function ganttRows(layout: GanttLayout, grid: Raw[][]): CellData[][] {
  const lines = keyedLines(layout, grid).filter(entry => !isBlank(entry.line[layout.source.task]))
  const scale = progressScale(
    layout,
    lines.map(entry => entry.line),
  )
  const col = (key: Left['key']) => layout.left.findIndex(item => item.key === key)
  const phaseOf = (line: Raw[]) => (layout.source.phase >= 0 ? String(line[layout.source.phase] ?? '').trim() : '')
  const groups: { phase: string; lines: typeof lines }[] = []
  for (const entry of lines) {
    const phase = phaseOf(entry.line)
    let group = groups.find(item => item.phase.toLowerCase() === phase.toLowerCase())
    if (!group) {
      group = { phase, lines: [] }
      groups.push(group)
    }
    group.lines.push(entry)
  }
  // Tasks with no phase go last.
  groups.sort((a, b) => Number(!a.phase) - Number(!b.phase))
  const out: CellData[][] = []
  const days = (row: number) => {
    const s = `${columnLetter(col('start'))}${row}`
    const e = col('end') >= 0 ? `${columnLetter(col('end'))}${row}` : s
    return { userEnteredValue: { formulaValue: `=IF(AND(ISNUMBER(${s}),ISNUMBER(${e})),NETWORKDAYS(${s},${e}),"")` } }
  }
  let number = 0
  for (const group of groups) {
    if (group.phase) {
      number += 1
      out.push(
        layout.left.map(item =>
          item.key === 'wbs'
            ? cell(number)
            : item.key === 'task'
              ? cell(group.phase)
              : item.key === 'snap'
                ? cell('P')
                : {},
        ),
      )
    }
    for (const entry of group.lines) {
      const row = HEAD_ROWS + 1 + out.length
      const value = (key: FieldKey): Raw => {
        const at = layout.source[key]
        if (at < 0) return ''
        const raw = entry.line[at]
        if (key === 'progress') {
          const n = asNumber(raw)
          return n === null ? (isBlank(raw) ? '' : raw) : n / scale.shown
        }
        return raw
      }
      const snapshot: Record<string, Raw> = {}
      for (const key of EDITABLE) if (col(key) >= 0) snapshot[key] = isBlank(value(key)) ? '' : value(key)
      out.push(
        layout.left.map(item =>
          item.key === 'snap'
            ? cell(JSON.stringify({ k: entry.key, v: snapshot }))
            : item.key === 'days'
              ? days(row)
              : cell(value(item.key)),
        ),
      )
    }
  }
  return out
}

// ---- edits made in the tab ----

export type GanttEdit = { key: string; field: FieldKey; value: Raw }

/**
 * What a person changed in the tab since it was last written: task rows (from the first task row down, read
 * unformatted) whose editable cells differ from their snapshot. Phase headings and rows without a snapshot are skipped.
 */
export function ganttEdits(layout: GanttLayout, rows: Raw[][]): GanttEdit[] {
  const at = (key: Left['key']) => layout.left.findIndex(item => item.key === key)
  const edits: GanttEdit[] = []
  for (const line of rows) {
    const raw = Array.isArray(line) ? line[at('snap')] : undefined
    if (typeof raw !== 'string' || !raw.startsWith('{')) continue
    let snap: { k?: string; v?: Record<string, Raw> }
    try {
      snap = JSON.parse(raw)
    } catch {
      continue
    }
    if (!snap.k || !snap.v) continue
    for (const field of EDITABLE) {
      if (at(field) < 0 || !(field in snap.v)) continue
      const now = line[at(field)]
      if (!sameValue(now, snap.v[field])) edits.push({ key: snap.k, field, value: isBlank(now) ? '' : now })
    }
  }
  return edits
}

const isoOfSerial = (serial: number) =>
  new Date(Math.round((serial - SHEETS_EPOCH) * 86_400_000)).toISOString().slice(0, 10)

/**
 * The synced tab's cells to write for edits made in the Gantt tab, as text Google reads as typed (dates as
 * YYYY-MM-DD, % done in the synced tab's own scale). Edits to rows no longer in the synced tab are dropped.
 */
export function trackerTabWrites(
  layout: GanttLayout,
  dataTab: string,
  grid: Raw[][],
  edits: GanttEdit[],
): { range: string; values: string[][] }[] {
  const lines = keyedLines(layout, grid)
  const rowOf = new Map(lines.map(entry => [entry.key.toLowerCase(), entry.row]))
  const scale = progressScale(
    layout,
    lines.map(entry => entry.line),
  )
  const writes: { range: string; values: string[][] }[] = []
  for (const edit of edits) {
    const row = rowOf.get(edit.key.toLowerCase())
    const column = layout.source[edit.field]
    if (!row || column < 0) continue
    let text: string
    const n = asNumber(edit.value)
    if (isBlank(edit.value)) text = ''
    else if ((edit.field === 'start' || edit.field === 'end') && typeof edit.value === 'number')
      text = isoOfSerial(edit.value)
    else if (edit.field === 'progress' && n !== null) text = String(Math.round(n * scale.written * 100) / 100)
    else text = String(edit.value)
    // A leading = + - @ would be read as a formula.
    if (/^[=+\-@]/.test(text) && edit.field !== 'progress') text = `'${text}`
    writes.push({ range: `${tabRange(dataTab)}!${columnLetter(column)}${row}`, values: [[text]] })
  }
  return writes
}

/** Whether the tab already shows these rows (Days formulas aside), so it need not be written again. */
export function ganttShows(layout: GanttLayout, rows: CellData[][], current: Raw[][]) {
  const days = layout.left.findIndex(item => item.key === 'days')
  const length = Math.max(
    rows.length,
    current.filter(line => Array.isArray(line) && line.some(v => !isBlank(v))).length,
  )
  for (let r = 0; r < length; r++)
    for (let c = 0; c < layout.left.length; c++) {
      if (c === days) continue
      const want = rows[r]?.[c]?.userEnteredValue
      const wanted = want ? (want.numberValue ?? want.stringValue ?? want.boolValue) : ''
      if (!sameValue(wanted as Raw, current[r]?.[c])) return false
    }
  return true
}

/** Writes the tab's rows again (values only; formats and rules stay), clearing what is below them. */
export function ganttRedrawRequests(layout: GanttLayout, sheetId: number, rows: CellData[][], rowCount: number) {
  const height = Math.max(rows.length, rowCount - HEAD_ROWS)
  return [
    {
      updateCells: {
        range: {
          sheetId,
          startRowIndex: HEAD_ROWS,
          endRowIndex: HEAD_ROWS + height,
          startColumnIndex: 0,
          endColumnIndex: layout.left.length,
        },
        rows: Array.from({ length: height }, (_, at) => ({ values: rows[at] || [] })),
        fields: 'userEnteredValue',
      },
    },
  ]
}

// ---- the tab itself ----

/**
 * The requests that add the Gantt chart tab: headings, calendar, column formats, the rows from the synced tab
 * (`grid`, read unformatted), colours and bars. Returns an error when the Sheet has no Start or task column to chart.
 */
export function ganttSheetRequests(input: {
  title: string
  dataTab: string
  headers: string[]
  fields: GanttFields
  sheetId: number
  /** The synced tab, header row first, read unformatted with dates as serial numbers. */
  grid: Raw[][]
  /** The synced tab's row count, so the list has room to grow. */
  dataRows: number
  /** Weeks shown from the Display week; 26 is half a year. */
  weeks?: number
}): { requests: unknown[] } | { error: string } {
  const layout = ganttLayout(input.headers, input.fields)
  if ('error' in layout) return layout
  const left = layout.left
  const col = (key: Left['key']) => left.findIndex(item => item.key === key)
  const L = (key: Left['key']) => columnLetter(col(key))
  const values = ganttRows(layout, input.grid)

  const first = HEAD_ROWS + 1 // the first task row, 1-based
  const rows = Math.max(input.dataRows + HEAD_ROWS + 40, values.length + HEAD_ROWS + 40, 200)
  const chart = left.length // first chart column, 0-based
  const days = Math.max(1, input.weeks ?? 26) * 7
  const columns = chart + days
  const startRange = `${tabRange(input.dataTab)}!$${columnLetter(layout.source.start)}$2:$${columnLetter(layout.source.start)}`

  // Controls beside the task column, as in the template: the project start and the week the chart starts on.
  const taskCol = col('task')
  const startCell = `$${columnLetter(taskCol + 1)}$2`
  const weekCell = `$${columnLetter(taskCol + 3)}$2`
  const monday = `(${startCell}-WEEKDAY(${startCell},2)+1)`

  type Cell = Record<string, unknown>
  const text = (value: string, format: Record<string, unknown> = {}): Cell => ({
    userEnteredValue: { stringValue: value },
    userEnteredFormat: format,
  })
  const formula = (value: string, format: Record<string, unknown> = {}): Cell => ({
    userEnteredValue: { formulaValue: value },
    userEnteredFormat: format,
  })
  const blank = (): Cell => ({})
  const grid: Cell[][] = Array.from({ length: HEAD_ROWS }, () => Array.from({ length: columns }, blank))
  const bold = { textFormat: { bold: true } }
  const headFormat = {
    backgroundColor: rgb(COLORS.head),
    textFormat: { bold: true, fontSize: 9 },
    verticalAlignment: 'MIDDLE',
    borders: { bottom: { style: 'SOLID_MEDIUM', color: rgb('#6aa84f') } },
  }

  grid[0][0] = text(`${input.title} – Project schedule`, { textFormat: { bold: true, fontSize: 14 } })
  grid[1][taskCol] = text('Project start', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 1] = formula(`=IF(COUNT(${startRange})=0,TODAY(),MIN(${startRange}))`, {
    numberFormat: { type: 'DATE', pattern: 'd mmm yyyy' },
    ...bold,
  })
  grid[1][taskCol + 2] = text('Display week', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 3] = {
    userEnteredValue: { numberValue: 1 },
    userEnteredFormat: { ...bold, horizontalAlignment: 'CENTER', backgroundColor: rgb('#fff2cc') },
    note: 'Change this to move the chart: 1 starts on the week the project starts, 2 a week later, and so on. Type a date over Project start to fix it.',
  }
  grid[2][0] = text(
    'You can change Lead, Start, End, % Done and Remarks here; the tracker picks them up on its next sync. Rename or add tasks in the tracker or its tab.',
    { textFormat: { italic: true, fontSize: 9, foregroundColor: rgb('#7f7f7f') } },
  )
  left.forEach((item, index) => {
    grid[HEAD_ROWS - 1][index] = text(item.header, headFormat)
  })

  // The calendar: month and year, week, day number and weekday letter for every day shown.
  for (let d = 0; d < days; d++) {
    const c = chart + d
    const dayCell = `${columnLetter(c)}$5`
    grid[4][c] = formula(d === 0 ? `=${monday}+7*(${weekCell}-1)` : `=${columnLetter(c - 1)}5+1`, {
      numberFormat: { type: 'DATE', pattern: 'd' },
      horizontalAlignment: 'CENTER',
      textFormat: { fontSize: 8 },
    })
    grid[5][c] = formula(`=CHOOSE(WEEKDAY(${dayCell},1),"S","M","T","W","T","F","S")`, {
      ...headFormat,
      horizontalAlignment: 'CENTER',
      textFormat: { bold: true, fontSize: 8 },
    })
    if (d % 7 === 0) {
      grid[2][c] = formula(`=TEXT(${dayCell},"mmmm yyyy")`, {
        horizontalAlignment: 'LEFT',
        backgroundColor: rgb(COLORS.band),
        textFormat: { bold: true },
      })
      grid[3][c] = formula(`="Week "&((${dayCell}-${monday})/7+1)&"  ·  "&TEXT(${dayCell},"d mmm")`, {
        horizontalAlignment: 'LEFT',
        textFormat: { fontSize: 9 },
      })
    }
  }

  const area = (r0: number, r1: number, c0: number, c1: number) => ({
    sheetId: input.sheetId,
    startRowIndex: r0,
    endRowIndex: r1,
    startColumnIndex: c0,
    endColumnIndex: c1,
  })
  const merges = []
  for (let d = 0; d < days; d += 7)
    for (const row of [2, 3])
      merges.push({ mergeCells: { range: area(row, row + 1, chart + d, chart + d + 7), mergeType: 'MERGE_ALL' } })
  const columnFormat = (key: Left['key'], format: Record<string, unknown>, fields: string) =>
    col(key) < 0
      ? []
      : [
          {
            repeatCell: {
              range: area(HEAD_ROWS, rows, col(key), col(key) + 1),
              cell: { userEnteredFormat: format },
              fields,
            },
          },
        ]
  const dateFormat = {
    numberFormat: { type: 'DATE', pattern: 'd mmm yyyy' },
    backgroundColor: rgb(COLORS.dates),
    horizontalAlignment: 'CENTER',
  }
  const formats = [
    ...columnFormat('start', dateFormat, 'userEnteredFormat(numberFormat,backgroundColor,horizontalAlignment)'),
    ...columnFormat('end', dateFormat, 'userEnteredFormat(numberFormat,backgroundColor,horizontalAlignment)'),
    ...columnFormat(
      'progress',
      { numberFormat: { type: 'PERCENT', pattern: '0%' }, horizontalAlignment: 'CENTER' },
      'userEnteredFormat(numberFormat,horizontalAlignment)',
    ),
    ...columnFormat('wbs', { horizontalAlignment: 'LEFT' }, 'userEnteredFormat.horizontalAlignment'),
    ...columnFormat('days', { horizontalAlignment: 'CENTER' }, 'userEnteredFormat.horizontalAlignment'),
  ]
  // Helpers for editing in the tab: Remarks takes the tracker's choices; dates must be dates.
  const validation = [
    ...(col('status') >= 0 && input.fields.statusOptions?.length
      ? [
          {
            setDataValidation: {
              range: area(HEAD_ROWS, rows, col('status'), col('status') + 1),
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: input.fields.statusOptions.map(option => ({ userEnteredValue: option })),
                },
                strict: false,
                showCustomUi: true,
              },
            },
          },
        ]
      : []),
    ...(['start', 'end'] as const).flatMap(key =>
      col(key) < 0
        ? []
        : [
            {
              setDataValidation: {
                range: area(HEAD_ROWS, rows, col(key), col(key) + 1),
                rule: { condition: { type: 'DATE_IS_VALID' }, strict: false },
              },
            },
          ],
    ),
  ]

  // Rules, written for the top-left cell of their range; references shift like any cell reference.
  const C = columnLetter(chart)
  const day = `${C}$5`
  const M = `$${L('snap')}${first}`
  const S = `$${L('start')}${first}`
  const E = col('end') >= 0 ? `IF(ISNUMBER($${L('end')}${first}),$${L('end')}${first},${S})` : S
  const P = col('progress') >= 0 ? `$${L('progress')}${first}` : ''
  const T = col('status') >= 0 ? `$${L('status')}${first}` : ''
  const doneWord = T ? `OR(${T}="Done",${T}="Completed",${T}="Complete")` : 'FALSE'
  // % done as a fraction; a Done status counts as finished.
  const pct = P ? `IF(${doneWord},1,IF(ISNUMBER(${P}),${P},0))` : `IF(${doneWord},1,0)`
  const inBar = `AND(ISNUMBER(${S}),${day}>=${S},${day}<=${E})`
  const rule = (ranges: unknown[], condition: string, format: Record<string, unknown>) => ({
    addConditionalFormatRule: {
      rule: {
        ranges,
        booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${condition}` }] }, format },
      },
      index: 0,
    },
  })
  const body = area(HEAD_ROWS, rows, chart, columns)
  const leftBody = area(HEAD_ROWS, rows, 0, chart)
  const fill = (color: string, extra: Record<string, unknown> = {}) => ({ backgroundColor: rgb(color), ...extra })
  // Added at index 0 one after another, so the last one listed is checked first.
  const rules = [
    rule([body], `WEEKDAY(${day},2)>5`, fill(COLORS.weekend)),
    rule([body], `${day}=TODAY()`, fill(COLORS.today)),
    rule([body], inBar, fill(COLORS.planned)),
    rule([body], `AND(${inBar},${E}<TODAY(),${pct}<1)`, fill(COLORS.late)),
    rule([body], `AND(${inBar},${day}<=${S}+ROUNDDOWN((${E}-${S}+1)*${pct},0)-1)`, fill(COLORS.bar)),
    rule([body], `AND(${inBar},${pct}>=1)`, fill(COLORS.bar)),
    rule([body], `${M}="P"`, fill(COLORS.phase)),
    ...(T
      ? [
          rule([area(HEAD_ROWS, rows, col('status'), col('status') + 1)], `${T}="Ongoing"`, fill(COLORS.ongoingStatus)),
          rule([area(HEAD_ROWS, rows, col('status'), col('status') + 1)], doneWord, fill(COLORS.doneStatus)),
        ]
      : []),
    ...(P
      ? [
          rule(
            [area(HEAD_ROWS, rows, col('progress'), col('progress') + 1)],
            `AND(ISNUMBER(${P}),${P}>=1)`,
            fill(COLORS.fullDone),
          ),
        ]
      : []),
    // Phase headings: bold on a grey band, over everything else in the row.
    rule([leftBody], `${M}="P"`, fill(COLORS.phase, { textFormat: { bold: true } })),
    rule(
      [area(4, 6, chart, columns)],
      `${day}=TODAY()`,
      fill(COLORS.todayHead, { textFormat: { bold: true, foregroundColor: rgb('#ffffff') } }),
    ),
  ]

  const width = (c0: number, c1: number, pixelSize: number) => ({
    updateDimensionProperties: {
      range: { sheetId: input.sheetId, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  })
  // Columns that are written again on every sync: a warning (not a lock) before they are typed over.
  const fixed = (['wbs', 'task', 'days'] as const).filter(key => col(key) >= 0)
  return {
    requests: [
      {
        addSheet: {
          properties: {
            sheetId: input.sheetId,
            title: GANTT_TAB,
            index: 0,
            tabColor: rgb(COLORS.bar),
            gridProperties: {
              rowCount: rows,
              columnCount: columns,
              frozenRowCount: HEAD_ROWS,
              frozenColumnCount: taskCol + 1,
            },
          },
        },
      },
      {
        updateCells: {
          range: area(0, HEAD_ROWS, 0, columns),
          rows: grid.map(cells => ({ values: cells })),
          fields: 'userEnteredValue,userEnteredFormat,note',
        },
      },
      ...formats,
      ...ganttRedrawRequests(layout, input.sheetId, values, values.length + HEAD_ROWS),
      ...validation,
      ...left.map((item, index) => width(index, index + 1, item.width)),
      width(chart, columns, 22),
      // The snapshot column is for the sync and the rules only.
      {
        updateDimensionProperties: {
          range: { sheetId: input.sheetId, dimension: 'COLUMNS', startIndex: col('snap'), endIndex: col('snap') + 1 },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
      ...merges,
      ...rules,
      ...fixed.map(key => ({
        addProtectedRange: {
          protectedRange: {
            range: area(HEAD_ROWS, rows, col(key), col(key) + 1),
            description: `${key === 'days' ? 'Days are worked out from Start and End.' : 'Task names and numbers come from the tracker.'} Change them in the tracker or its ${input.dataTab} tab; this tab is written again on the next sync.`,
            warningOnly: true,
          },
        },
      })),
    ],
  }
}

/**
 * Only a tracker made from the Project timeline template has a Gantt chart tab in its Google Sheet. Every other
 * tracker's Sheet is just its columns and rows, however many date columns it has.
 */
export const sheetHasGantt = (template: unknown) => template === 'project-timeline'

/**
 * Which Sheet headers the chart reads, from the tracker's Timeline settings (or its guesses) and the connection's
 * header map. Null when the Start column is not one the Sheet holds.
 */
export function ganttFields(
  columns: TrackerColumn[],
  timeline: TimelineSettings | undefined,
  headerMap: Record<string, string>,
  keyHeader: string,
): GanttFields | null {
  const fields = settleTimelineFields(columns, timeline?.fields || null)
  const headerOf = new Map(Object.entries(headerMap).map(([header, id]) => [id, header]))
  const pick = (id: string) => (id ? headerOf.get(id) : undefined)
  const start = pick(fields.startId)
  if (!start || !keyHeader) return null
  const wbs = columns.find(column => column.type === 'text' && /^wbs$|^#$|^no\.?$/i.test(column.name.trim()))
  const status = columns.find(column => column.id === fields.statusId)
  return {
    task: keyHeader,
    start,
    wbs: wbs ? pick(wbs.id) : undefined,
    phase: pick(fields.groupId),
    lead: pick(fields.leadId),
    end: pick(fields.endId),
    progress: pick(fields.progressId),
    status: pick(fields.statusId),
    ...(status?.options?.length ? { statusOptions: status.options.map(option => option.label) } : {}),
  }
}
