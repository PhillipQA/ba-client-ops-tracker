/**
 * A "Gantt chart" tab for a Google Sheet that a tracker follows, laid out like a project schedule kept in a
 * spreadsheet: month and year, week, day and weekday across the top, the tasks down the left, and bars drawn by
 * conditional formatting that fill in by % done. The left columns are formulas that read the synced tab, so the chart
 * follows every sync without being written again. Pure functions: the server sends what they return to the Sheets API.
 */
import { settleTimelineFields, type TimelineSettings } from './timelineModel'
import type { TrackerColumn } from './trackerModel'
import { tabRange } from './trackerSync'

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
const COLORS = {
  done: '#6aa84f',
  progress: '#3d85c6',
  late: '#f4cccc',
  planned: '#c9daf8',
  today: '#fde2e2',
  todayHead: '#e06666',
  weekend: '#f3f3f3',
  head: '#434343',
  band: '#efefef',
}

/** Rows above the tasks: title, controls, month and year, week, day, weekday (and the column headers). */
const HEAD_ROWS = 6

/**
 * The requests that add the Gantt chart tab. `headers` is the synced tab's header row; `fields` names which header
 * holds what. `dataRows` is the synced tab's row count, so the formulas have room below them. Returns an error when
 * the Sheet has no Start or task column to chart.
 */
export function ganttSheetRequests(input: {
  title: string
  dataTab: string
  headers: string[]
  fields: GanttFields
  sheetId: number
  dataRows: number
  /** Weeks shown from the Display week; 26 is half a year. */
  weeks?: number
}): { requests: unknown[] } | { error: string } {
  const at = (header?: string) =>
    header ? input.headers.findIndex(item => item.trim().toLowerCase() === header.trim().toLowerCase()) : -1
  const source = {
    wbs: at(input.fields.wbs),
    task: at(input.fields.task),
    phase: at(input.fields.phase),
    lead: at(input.fields.lead),
    start: at(input.fields.start),
    end: at(input.fields.end),
    progress: at(input.fields.progress),
    status: at(input.fields.status),
  }
  if (source.task < 0) return { error: 'The Sheet has no column that names each task, so there is nothing to chart.' }
  if (source.start < 0) return { error: 'The Sheet has no Start date column, so there is nothing to chart.' }

  // The left block: what the chart shows next to each bar, in the order a schedule reads.
  type Left = { key: string; header: string; width: number; from?: number; format?: 'date' | 'number' | 'days' }
  const left: Left[] = []
  if (source.wbs >= 0) left.push({ key: 'wbs', header: 'WBS', width: 50, from: source.wbs })
  left.push({ key: 'task', header: input.headers[source.task] || 'Task', width: 300, from: source.task })
  if (source.phase >= 0) left.push({ key: 'phase', header: 'Phase', width: 130, from: source.phase })
  if (source.lead >= 0) left.push({ key: 'lead', header: 'Lead', width: 130, from: source.lead })
  left.push({ key: 'start', header: 'Start', width: 95, from: source.start, format: 'date' })
  if (source.end >= 0) left.push({ key: 'end', header: 'End', width: 95, from: source.end, format: 'date' })
  left.push({ key: 'days', header: 'Days', width: 50, format: 'days' })
  if (source.progress >= 0)
    left.push({ key: 'progress', header: '% Done', width: 65, from: source.progress, format: 'number' })
  if (source.status >= 0) left.push({ key: 'status', header: 'Status', width: 90, from: source.status })
  const col = (key: string) => left.findIndex(item => item.key === key)
  const L = (key: string) => columnLetter(col(key))

  const first = HEAD_ROWS + 1 // the first task row, 1-based
  const rows = Math.max(input.dataRows + HEAD_ROWS + 5, 200)
  const chart = left.length // first chart column, 0-based
  const days = Math.max(1, input.weeks ?? 26) * 7
  const columns = chart + days
  const tab = tabRange(input.dataTab)
  const keyRange = `${tab}!$${columnLetter(source.task)}$2:$${columnLetter(source.task)}`

  // Controls next to the task column, as in the sheet: the project start and the week the chart starts on.
  const taskCol = col('task')
  const startCell = `$${columnLetter(taskCol + 1)}$2`
  const weekCell = `$${columnLetter(taskCol + 3)}$2`
  const startColumn = `${tab}!$${columnLetter(source.start)}$2:$${columnLetter(source.start)}`
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
  const grid: Cell[][] = Array.from({ length: HEAD_ROWS + 1 }, () => Array.from({ length: columns }, blank))
  const bold = { textFormat: { bold: true } }
  const dateFormat = { numberFormat: { type: 'DATE', pattern: 'd mmm yyyy' } }

  grid[0][0] = text(`${input.title} – Project schedule`, { textFormat: { bold: true, fontSize: 14 } })
  grid[1][taskCol] = text('Project start', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 1] = formula(`=IF(COUNT(${startColumn})=0,TODAY(),MIN(${startColumn}))`, { ...dateFormat, ...bold })
  grid[1][taskCol + 2] = text('Display week', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 3] = {
    userEnteredValue: { numberValue: 1 },
    userEnteredFormat: { ...bold, horizontalAlignment: 'CENTER', backgroundColor: rgb('#fff2cc') },
    note: 'Change this to move the chart: 1 starts on the week the project starts, 2 a week later, and so on. Type a date over Project start to fix it.',
  }

  // Column headers, and the formulas that bring each task's values over from the synced tab.
  left.forEach((item, index) => {
    grid[HEAD_ROWS - 1][index] = text(item.header, {
      ...bold,
      backgroundColor: rgb(COLORS.head),
      textFormat: { bold: true, foregroundColor: rgb('#ffffff') },
      verticalAlignment: 'MIDDLE',
    })
    const format =
      item.format === 'date'
        ? { numberFormat: { type: 'DATE', pattern: 'd mmm yyyy' } }
        : item.format === 'days' || item.format === 'number'
          ? { horizontalAlignment: 'RIGHT' }
          : {}
    if (item.format === 'days') {
      const s = `${L('start')}${first}:${L('start')}`
      const e = col('end') >= 0 ? `${L('end')}${first}:${L('end')}` : s
      grid[HEAD_ROWS][index] = formula(
        `=ARRAYFORMULA(IF(ISNUMBER(${s})*ISNUMBER(${e})=0,,NETWORKDAYS(${s},${e})))`,
        format,
      )
    } else {
      const from = columnLetter(item.from!)
      grid[HEAD_ROWS][index] = formula(`=ARRAYFORMULA(IF(${keyRange}="",,${tab}!$${from}$2:$${from}))`, format)
    }
  })

  // The calendar: month and year, week, day number and weekday letter for every day shown.
  for (let d = 0; d < days; d++) {
    const c = chart + d
    const here = columnLetter(c)
    const dayCell = `${here}$5`
    grid[4][c] = formula(d === 0 ? `=${monday}+7*(${weekCell}-1)` : `=${columnLetter(c - 1)}5+1`, {
      numberFormat: { type: 'DATE', pattern: 'd' },
      horizontalAlignment: 'CENTER',
      textFormat: { fontSize: 8 },
    })
    grid[5][c] = formula(`=CHOOSE(WEEKDAY(${dayCell},1),"S","M","T","W","T","F","S")`, {
      horizontalAlignment: 'CENTER',
      backgroundColor: rgb(COLORS.head),
      textFormat: { bold: true, fontSize: 8, foregroundColor: rgb('#ffffff') },
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

  const range = (r0: number, r1: number, c0: number, c1: number) => ({
    sheetId: input.sheetId,
    startRowIndex: r0,
    endRowIndex: r1,
    startColumnIndex: c0,
    endColumnIndex: c1,
  })
  const merges = []
  for (let d = 0; d < days; d += 7)
    for (const row of [2, 3])
      merges.push({ mergeCells: { range: range(row, row + 1, chart + d, chart + d + 7), mergeType: 'MERGE_ALL' } })

  // Bars. Formulas are written for the top-left chart cell and shift across and down like any cell reference.
  const C = columnLetter(chart)
  const day = `${C}$5`
  const S = `$${L('start')}${first}`
  const E = col('end') >= 0 ? `IF(ISNUMBER($${L('end')}${first}),$${L('end')}${first},${S})` : S
  const P = col('progress') >= 0 ? `$${L('progress')}${first}` : ''
  const T = col('status') >= 0 ? `$${L('status')}${first}` : ''
  const doneWord = T ? `OR(${T}="Done",${T}="Completed",${T}="Complete")` : 'FALSE'
  // % done as a fraction: values of 0–1 (how Excel keeps 90%) unless the column has a value above 1, as in the app.
  const pct = P
    ? `IF(ISNUMBER(${P}),IF(MAX($${L('progress')}$${first}:$${L('progress')})>1,${P}/100,${P}),IF(${doneWord},1,0))`
    : `IF(${doneWord},1,0)`
  const inBar = `AND(ISNUMBER(${S}),${day}>=${S},${day}<=${E})`
  const rule = (condition: string, color: string, r0 = HEAD_ROWS, extra: Record<string, unknown> = {}) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range(r0, rows, chart, columns)],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${condition}` }] },
          format: { backgroundColor: rgb(color), ...extra },
        },
      },
      index: 0,
    },
  })
  // Added at index 0 one after another, so the last one listed is checked first: weekend < today < bar states.
  const rules = [
    rule(`WEEKDAY(${day},2)>5`, COLORS.weekend),
    rule(`${day}=TODAY()`, COLORS.today),
    rule(inBar, COLORS.planned),
    rule(`AND(${inBar},${E}<TODAY(),${pct}<1)`, COLORS.late),
    rule(`AND(${inBar},${day}<=${S}+ROUNDDOWN((${E}-${S}+1)*${pct},0)-1)`, COLORS.progress),
    rule(`AND(${inBar},${pct}>=1)`, COLORS.done),
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [range(4, 6, chart, columns)],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=${day}=TODAY()` }] },
            format: {
              backgroundColor: rgb(COLORS.todayHead),
              textFormat: { bold: true, foregroundColor: rgb('#ffffff') },
            },
          },
        },
        index: 0,
      },
    },
  ]

  const width = (c0: number, c1: number, pixelSize: number) => ({
    updateDimensionProperties: {
      range: { sheetId: input.sheetId, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  })
  return {
    requests: [
      {
        addSheet: {
          properties: {
            sheetId: input.sheetId,
            title: GANTT_TAB,
            index: 0,
            tabColor: rgb('#3d85c6'),
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
          range: range(0, HEAD_ROWS + 1, 0, columns),
          rows: grid.map(values => ({ values })),
          fields: 'userEnteredValue,userEnteredFormat,note',
        },
      },
      ...left.map((item, index) => width(index, index + 1, item.width)),
      width(chart, columns, 22),
      ...merges,
      ...rules,
    ],
  }
}

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
  return {
    task: keyHeader,
    start,
    wbs: wbs ? pick(wbs.id) : undefined,
    phase: pick(fields.groupId),
    lead: pick(fields.leadId),
    end: pick(fields.endId),
    progress: pick(fields.progressId),
    status: pick(fields.statusId),
  }
}
