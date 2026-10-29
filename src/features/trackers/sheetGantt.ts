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

/** Rows above the tasks: title, controls, month and year, week, day, and weekday with the column headers. */
const HEAD_ROWS = 6

/** Formula text: a string in double quotes. */
const quoted = (text: string) => `"${text.replace(/"/g, '""')}"`

/**
 * The requests that add the Gantt chart tab, laid out like the project schedule template: phase headings ("1 Project
 * Planning") in bold on a grey band with their tasks under them, Start and End as dates, % Done as a percentage, Status
 * coloured, and bars that fill in by % done. `headers` is the synced tab's header row; `fields` names which header
 * holds what. One formula builds the list from the synced tab, so the chart follows every sync. `dataRows` is the synced
 * tab's row count, so the list has room. Returns an error when the Sheet has no Start or task column to chart.
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

  const tab = tabRange(input.dataTab)
  const range = (index: number) => `${tab}!$${columnLetter(index)}$2:$${columnLetter(index)}`
  // The left block, in the template's order. All but Days come out of one formula; the last of those is a hidden
  // marker that says which rows are phase headings.
  type Left = { key: string; header: string; width: number; value?: string }
  const left: Left[] = []
  if (source.wbs >= 0) left.push({ key: 'wbs', header: 'WBS', width: 50, value: range(source.wbs) })
  left.push({ key: 'task', header: 'TASK', width: 320, value: range(source.task) })
  if (source.lead >= 0) left.push({ key: 'lead', header: 'LEAD', width: 140, value: range(source.lead) })
  left.push({ key: 'start', header: 'START', width: 95, value: range(source.start) })
  if (source.end >= 0) left.push({ key: 'end', header: 'END', width: 95, value: range(source.end) })
  if (source.progress >= 0)
    // As a fraction, whether the column holds 0–100 or 0–1 (how Excel keeps 90%), shown as a percentage.
    left.push({
      key: 'progress',
      header: '% DONE',
      width: 70,
      value: `MAP(pr,LAMBDA(v,IF(ISNUMBER(v),IF(mx>1,v/100,v),"")))`,
    })
  if (source.status >= 0) left.push({ key: 'status', header: 'REMARKS', width: 95, value: range(source.status) })
  left.push({ key: 'marker', header: '', width: 20, value: 'MAP(k,LAMBDA(v,""))' })
  left.push({ key: 'days', header: 'DAYS', width: 55 })
  const col = (key: string) => left.findIndex(item => item.key === key)
  const L = (key: string) => columnLetter(col(key))
  const spilled = left.filter(item => item.key !== 'days')

  const first = HEAD_ROWS + 1 // the first task row, 1-based
  const rows = Math.max(input.dataRows + HEAD_ROWS + 40, 200)
  const chart = left.length // first chart column, 0-based
  const days = Math.max(1, input.weeks ?? 26) * 7
  const columns = chart + days

  // The list: headers, then each phase's heading row and its tasks, in the order phases first appear; tasks with no
  // phase come last. Without a Phase column it is the tasks as they are.
  const header = `HSTACK(${spilled.map(item => quoted(item.header)).join(',')})`
  const phaseRow = `HSTACK(${spilled
    .map(item => (item.key === 'wbs' ? 'i' : item.key === 'task' ? 'g' : item.key === 'marker' ? '"P"' : '""'))
    .join(',')})`
  const rowsOf = `FILTER(HSTACK(${spilled.map(item => item.value).join(',')}),k<>"")`
  const vars = [
    `k,${range(source.task)}`,
    ...(source.progress >= 0 ? [`pr,${range(source.progress)}`, 'mx,MAX(pr)'] : []),
    `dt,${rowsOf}`,
    `hd,${header}`,
  ]
  const list =
    source.phase >= 0
      ? `=LET(${[
          ...vars,
          `rp,FILTER(${range(source.phase)},k<>"")`,
          'gs,UNIQUE(VSTACK(IFERROR(UNIQUE(FILTER(rp,rp<>"")),""),""))',
          `REDUCE(hd,SEQUENCE(ROWS(gs)),LAMBDA(acc,i,LET(g,INDEX(gs,i),IF(g="",IF(SUMPRODUCT(--(rp=""))=0,acc,VSTACK(acc,FILTER(dt,rp=""))),VSTACK(acc,${phaseRow},FILTER(dt,rp=g))))))`,
        ].join(',')})`
      : `=LET(${[...vars, 'VSTACK(hd,dt)'].join(',')})`

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
  const grid: Cell[][] = Array.from({ length: HEAD_ROWS + 1 }, () => Array.from({ length: columns }, blank))
  const bold = { textFormat: { bold: true } }
  const headFormat = {
    backgroundColor: rgb(COLORS.head),
    textFormat: { bold: true, fontSize: 9 },
    verticalAlignment: 'MIDDLE',
    borders: { bottom: { style: 'SOLID_MEDIUM', color: rgb('#6aa84f') } },
  }

  grid[0][0] = text(`${input.title} – Project schedule`, { textFormat: { bold: true, fontSize: 14 } })
  grid[1][taskCol] = text('Project start', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 1] = formula(`=IF(COUNT(${range(source.start)})=0,TODAY(),MIN(${range(source.start)}))`, {
    numberFormat: { type: 'DATE', pattern: 'd mmm yyyy' },
    ...bold,
  })
  grid[1][taskCol + 2] = text('Display week', { ...bold, horizontalAlignment: 'RIGHT' })
  grid[1][taskCol + 3] = {
    userEnteredValue: { numberValue: 1 },
    userEnteredFormat: { ...bold, horizontalAlignment: 'CENTER', backgroundColor: rgb('#fff2cc') },
    note: 'Change this to move the chart: 1 starts on the week the project starts, 2 a week later, and so on. Type a date over Project start to fix it.',
  }
  // The list's formula sits in the header row and writes the headers itself; the other header cells only hold formats.
  left.forEach((_item, index) => {
    grid[HEAD_ROWS - 1][index] = { userEnteredFormat: headFormat }
  })
  grid[HEAD_ROWS - 1][0] = formula(list, headFormat)
  grid[HEAD_ROWS - 1][col('days')] = text('DAYS', headFormat)
  const s = `${L('start')}${first}:${L('start')}`
  const e = col('end') >= 0 ? `${L('end')}${first}:${L('end')}` : s
  grid[HEAD_ROWS][col('days')] = formula(`=ARRAYFORMULA(IF(ISNUMBER(${s})*ISNUMBER(${e})=0,,NETWORKDAYS(${s},${e})))`, {
    horizontalAlignment: 'CENTER',
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
  // Column formats for every task row (the formula's values take them).
  const columnFormat = (key: string, format: Record<string, unknown>, fields: string) =>
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
  ]

  // Rules, written for the top-left cell of their range; references shift like any cell reference.
  const C = columnLetter(chart)
  const day = `${C}$5`
  const M = `$${L('marker')}${first}`
  const S = `$${L('start')}${first}`
  const E = col('end') >= 0 ? `IF(ISNUMBER($${L('end')}${first}),$${L('end')}${first},${S})` : S
  const P = col('progress') >= 0 ? `$${L('progress')}${first}` : ''
  const T = col('status') >= 0 ? `$${L('status')}${first}` : ''
  const doneWord = T ? `OR(${T}="Done",${T}="Completed",${T}="Complete")` : 'FALSE'
  // % done as a fraction (the list already turned 0–100 into 0–1); a Done status counts as finished.
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
          range: area(0, HEAD_ROWS + 1, 0, columns),
          rows: grid.map(values => ({ values })),
          fields: 'userEnteredValue,userEnteredFormat,note',
        },
      },
      ...formats,
      ...left.map((item, index) => width(index, index + 1, item.width)),
      width(chart, columns, 22),
      // The marker column is only for the rules.
      {
        updateDimensionProperties: {
          range: {
            sheetId: input.sheetId,
            dimension: 'COLUMNS',
            startIndex: col('marker'),
            endIndex: col('marker') + 1,
          },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
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
