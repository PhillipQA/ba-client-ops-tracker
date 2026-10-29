import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GANTT_TAB,
  columnLetter,
  ganttEdits,
  ganttFields,
  ganttLayout,
  ganttRows,
  ganttSheetRequests,
  ganttShows,
  trackerTabWrites,
} from '../src/features/trackers/sheetGantt'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'

const headers = ['Task', 'WBS', 'Phase', 'Lead', 'Predecessor', 'Start', 'End', '% Done', 'Status']
const fields = {
  task: 'Task',
  wbs: 'WBS',
  phase: 'Phase',
  lead: 'Lead',
  start: 'Start',
  end: 'End',
  progress: '% Done',
  status: 'Status',
  statusOptions: ['Pending', 'Ongoing', 'Done'],
}
// The synced tab as Google returns it unformatted: dates are serial numbers (46328 = 2 Nov 2026).
const grid = [
  headers,
  ['Formal Kickoff', '1.1', 'Project Planning', 'iRipple & Client', '', 46328, 46328, 100, 'Done'],
  ['Creation & Importing', '2.1', 'Data Build-up', 'iRipple', '1.1', 46333, 46360, 50, 'Ongoing'],
  ['BPM Discussion', '1.2', 'Project Planning', 'iRipple & Client', '1.1', 46330, 46330, 0, 'Pending'],
  ['Loose task', '', '', 'Client', '', 46340, 46341, 0, 'Pending'],
]
const layout = ganttLayout(headers, fields) as Exclude<ReturnType<typeof ganttLayout>, { error: string }>
const raw = (rows: any[][]) =>
  rows.map(row => row.map(cell => cell?.userEnteredValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? ''))

test('column letters run A…Z, AA…ZZ, AAA', () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnLetter), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
})

test('the tab lists phase headings with their tasks under them, as values anyone can edit', () => {
  assert.deepEqual(
    layout.left.map(item => item.header),
    ['WBS', 'TASK', 'LEAD', 'START', 'END', '% DONE', 'REMARKS', '', 'DAYS'],
  )
  const rows = ganttRows(layout, grid)
  const shown = raw(rows)
  assert.deepEqual(
    shown.map(row => row.slice(0, 2)),
    [
      [1, 'Project Planning'],
      ['1.1', 'Formal Kickoff'],
      ['1.2', 'BPM Discussion'],
      [2, 'Data Build-up'],
      ['2.1', 'Creation & Importing'],
      ['', 'Loose task'],
    ],
    'phases in the order they first appear, tasks without a phase last',
  )
  assert.equal(shown[0][7], 'P', 'the hidden column marks phase headings')
  assert.deepEqual(shown[1].slice(2, 7), ['iRipple & Client', 46328, 46328, 1, 'Done'], '100 shows as 100%')
  assert.equal(shown[4][5], 0.5)
  assert.deepEqual(JSON.parse(shown[1][7]), {
    k: 'Formal Kickoff',
    v: { lead: 'iRipple & Client', start: 46328, end: 46328, progress: 1, status: 'Done' },
  })
  assert.equal(
    rows[1][8].userEnteredValue?.formulaValue,
    '=IF(AND(ISNUMBER(D8),ISNUMBER(E8)),NETWORKDAYS(D8,E8),"")',
    'Days on each row, from its own Start and End',
  )
  assert.equal(ganttShows(layout, rows, shown), true, 'nothing to write when the tab already shows it')
})

test('changes made in the tab are found, and written to the synced tab in its own terms', () => {
  const shown = raw(ganttRows(layout, grid))
  // A client moves BPM Discussion's End by a week, sets it Ongoing at 40%, and changes the lead of 2.1.
  shown[2][4] = 46335
  shown[2][5] = 0.4
  shown[2][6] = 'Ongoing'
  shown[4][2] = 'iRipple & HeroHub'
  shown[0][1] = 'Renamed phase' // phase headings are not edits
  const edits = ganttEdits(layout, shown)
  assert.deepEqual(edits, [
    { key: 'BPM Discussion', field: 'end', value: 46335 },
    { key: 'BPM Discussion', field: 'progress', value: 0.4 },
    { key: 'BPM Discussion', field: 'status', value: 'Ongoing' },
    { key: 'Creation & Importing', field: 'lead', value: 'iRipple & HeroHub' },
  ])
  assert.deepEqual(trackerTabWrites(layout, 'Tracker', grid, edits), [
    { range: "'Tracker'!G4", values: [['2026-11-09']] },
    { range: "'Tracker'!H4", values: [['40']] },
    { range: "'Tracker'!I4", values: [['Ongoing']] },
    { range: "'Tracker'!D3", values: [['iRipple & HeroHub']] },
  ])
  assert.equal(ganttShows(layout, ganttRows(layout, grid), shown), false)
  // Cleared cells clear the synced tab; text that looks like a formula stays text.
  assert.deepEqual(
    trackerTabWrites(layout, 'Tracker', grid, [
      { key: 'Loose task', field: 'end', value: '' },
      { key: 'Loose task', field: 'status', value: '=1+1' },
      { key: 'Gone', field: 'lead', value: 'x' },
    ]),
    [
      { range: "'Tracker'!G5", values: [['']] },
      { range: "'Tracker'!I5", values: [["'=1+1"]] },
    ],
  )
})

test('% done keeps the synced tab’s scale: 0–1 stays 0–1', () => {
  const fractions = [headers, ['A', '1', 'P', '', '', 46328, 46330, 0.5, 'Ongoing']]
  const shown = raw(ganttRows(layout, fractions))
  shown[1][5] = 0.75
  assert.deepEqual(trackerTabWrites(layout, 'Tracker', fractions, ganttEdits(layout, shown)), [
    { range: "'Tracker'!H2", values: [['0.75']] },
  ])
})

test('the tab: headings, calendar, formats, rows, dropdown, warnings on the columns the sync rewrites', () => {
  const out = ganttSheetRequests({
    title: 'Barter XI',
    dataTab: 'Tracker',
    headers,
    fields,
    sheetId: 5,
    grid,
    dataRows: 1200,
  })
  if ('error' in out) throw new Error(out.error)
  const requests = out.requests as any[]
  const sheet = requests[0].addSheet.properties
  assert.equal(sheet.title, GANTT_TAB)
  assert.equal(sheet.gridProperties.frozenColumnCount, 2)
  const head = requests[1].updateCells.rows.map((row: any) => row.values)
  assert.deepEqual(
    head[5].slice(0, 9).map((cell: any) => cell.userEnteredValue?.stringValue),
    ['WBS', 'TASK', 'LEAD', 'START', 'END', '% DONE', 'REMARKS', '', 'DAYS'],
    'headers are plain text, not a formula',
  )
  assert.match(head[2][0].userEnteredValue.stringValue, /You can change Lead, Start, End, % Done and Remarks here/)
  assert.equal(head[2][9].userEnteredValue.formulaValue, '=TEXT(J$5,"mmmm yyyy")')
  const values = requests.find((r: any) => r.updateCells?.range.startRowIndex === 6).updateCells
  assert.equal(values.fields, 'userEnteredValue')
  assert.equal(values.rows.length, 6)
  const remarks = requests.find(
    (r: any) => r.setDataValidation?.rule.condition.type === 'ONE_OF_LIST',
  ).setDataValidation
  assert.deepEqual(
    remarks.rule.condition.values.map((v: any) => v.userEnteredValue),
    ['Pending', 'Ongoing', 'Done'],
  )
  const warned = requests.filter((r: any) => r.addProtectedRange).map((r: any) => r.addProtectedRange.protectedRange)
  assert.deepEqual(
    warned.map((p: any) => [p.range.startColumnIndex, p.warningOnly]),
    [
      [0, true],
      [1, true],
      [8, true],
    ],
    'WBS, Task and Days warn; Lead, Start, End, % Done and Remarks are free to edit',
  )
  const hidden = requests.find((r: any) => r.updateDimensionProperties?.properties.hiddenByUser)
  assert.equal(hidden.updateDimensionProperties.range.startIndex, 7)
  const rules = requests.filter((r: any) => r.addConditionalFormatRule).map((r: any) => r.addConditionalFormatRule.rule)
  const phase = rules.filter((rule: any) => rule.booleanRule.condition.values[0].userEnteredValue === '=$H7="P"')
  assert.equal(phase.length, 2, 'phase headings banded across the list and the chart')
  assert.equal(
    phase.find((rule: any) => rule.ranges[0].startColumnIndex === 0).booleanRule.format.textFormat.bold,
    true,
  )
})

test('without a Start column there is nothing to chart; with only Task and Start it still works', () => {
  assert.deepEqual(ganttLayout(['Task'], { task: 'Task', start: 'Start' }), {
    error: 'The Sheet has no Start date column, so there is nothing to chart.',
  })
  const small = ganttSheetRequests({
    title: 'x',
    dataTab: 'T',
    headers: ['Task', 'Start'],
    fields: { task: 'Task', start: 'Start' },
    sheetId: 1,
    grid: [
      ['Task', 'Start'],
      ['A', 46328],
    ],
    dataRows: 10,
  })
  assert.ok('requests' in small)
})

test('the chart follows the Timeline settings, through the Sheet headers', () => {
  const columns: TrackerColumn[] = [
    { id: 'c1', name: 'Task', type: 'text' },
    { id: 'c2', name: 'WBS', type: 'text' },
    { id: 'c3', name: 'Kickoff', type: 'date' },
    { id: 'c4', name: 'Target', type: 'date' },
    { id: 'c5', name: 'Owner', type: 'text' },
  ]
  const map = { Task: 'c1', WBS: 'c2', Kickoff: 'c3', 'Target date': 'c4' }
  assert.deepEqual(ganttFields(columns, undefined, map, 'Task'), {
    task: 'Task',
    start: 'Kickoff',
    wbs: 'WBS',
    phase: undefined,
    lead: undefined,
    end: 'Target date',
    progress: undefined,
    status: undefined,
  })
  assert.equal(ganttFields(columns, { fields: { startId: 'c4', endId: '' } }, map, 'Task')?.start, 'Target date')
  assert.equal(ganttFields(columns, undefined, { Task: 'c1' }, 'Task'), null, 'no date column in the Sheet')
})
