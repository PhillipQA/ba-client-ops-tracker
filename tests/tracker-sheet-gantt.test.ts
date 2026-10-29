import test from 'node:test'
import assert from 'node:assert/strict'
import { GANTT_TAB, columnLetter, ganttFields, ganttSheetRequests } from '../src/features/trackers/sheetGantt'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'

const headers = [
  'Task',
  'WBS',
  'Phase',
  'Lead',
  'Predecessor',
  'Start',
  'End',
  '% Done',
  'Status',
  'Man-days',
  'Remarks',
]
const fields = {
  task: 'Task',
  wbs: 'WBS',
  phase: 'Phase',
  lead: 'Lead',
  start: 'Start',
  end: 'End',
  progress: '% Done',
  status: 'Status',
}
const build = () => {
  const out = ganttSheetRequests({
    title: 'Barter XI',
    dataTab: 'Tracker',
    headers,
    fields,
    sheetId: 555,
    dataRows: 1200,
  })
  if ('error' in out) throw new Error(out.error)
  return out.requests as any[]
}

test('column letters run A…Z, AA…ZZ, AAA', () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnLetter), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA'])
})

test('the Gantt tab reads the synced tab with formulas and lays out months, weeks, days and weekdays', () => {
  const requests = build()
  const sheet = requests[0].addSheet.properties
  assert.equal(sheet.title, GANTT_TAB)
  assert.equal(sheet.gridProperties.frozenRowCount, 6)
  assert.equal(sheet.gridProperties.frozenColumnCount, 2, 'WBS and Task stay in view')
  assert.equal(sheet.gridProperties.rowCount, 1211, 'room for every synced row below the headers')
  // Left block: WBS, Task, Phase, Lead, Start, End, Days, % Done, Status → the chart starts in column J.
  assert.equal(sheet.gridProperties.columnCount, 9 + 182)
  const rows = requests[1].updateCells.rows.map((row: any) => row.values)
  const value = (r: number, c: number) => rows[r][c].userEnteredValue
  assert.deepEqual(
    rows[5].slice(0, 9).map((cell: any) => cell.userEnteredValue.stringValue),
    ['WBS', 'Task', 'Phase', 'Lead', 'Start', 'End', 'Days', '% Done', 'Status'],
  )
  assert.equal(value(6, 1).formulaValue, "=ARRAYFORMULA(IF('Tracker'!$A$2:$A=\"\",,'Tracker'!$A$2:$A))")
  assert.equal(value(6, 0).formulaValue, "=ARRAYFORMULA(IF('Tracker'!$A$2:$A=\"\",,'Tracker'!$B$2:$B))")
  assert.equal(value(6, 4).formulaValue, "=ARRAYFORMULA(IF('Tracker'!$A$2:$A=\"\",,'Tracker'!$F$2:$F))")
  assert.equal(
    value(6, 6).formulaValue,
    '=ARRAYFORMULA(IF(ISNUMBER(E7:E)*ISNUMBER(F7:F)=0,,NETWORKDAYS(E7:E,F7:F)))',
    'working days, like the DAYS column',
  )
  // Controls beside the task column, like Project Start Date and Display Week in the sheet.
  assert.equal(value(1, 2).formulaValue, "=IF(COUNT('Tracker'!$F$2:$F)=0,TODAY(),MIN('Tracker'!$F$2:$F))")
  assert.equal(value(1, 4).numberValue, 1)
  // The calendar, from column J.
  assert.equal(value(4, 9).formulaValue, '=($C$2-WEEKDAY($C$2,2)+1)+7*($E$2-1)')
  assert.equal(value(4, 10).formulaValue, '=J5+1')
  assert.equal(value(5, 9).formulaValue, '=CHOOSE(WEEKDAY(J$5,1),"S","M","T","W","T","F","S")')
  assert.equal(value(2, 9).formulaValue, '=TEXT(J$5,"mmmm yyyy")', 'month and year')
  assert.equal(value(3, 16).formulaValue, '="Week "&((Q$5-($C$2-WEEKDAY($C$2,2)+1))/7+1)&"  ·  "&TEXT(Q$5,"d mmm")')
  assert.equal(rows[2][10].userEnteredValue, undefined, 'one label per week; the cells are merged')
  assert.equal(requests.filter(r => r.mergeCells).length, 52)
})

test('bars are conditional formatting: done, in progress, late, planned, today and weekends', () => {
  const rules = build()
    .filter(r => r.addConditionalFormatRule)
    .map(r => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue)
  assert.equal(rules.length, 7)
  assert.equal(rules[0], '=WEEKDAY(J$5,2)>5')
  assert.equal(rules[1], '=J$5=TODAY()')
  assert.equal(rules[2], '=AND(ISNUMBER($E7),J$5>=$E7,J$5<=IF(ISNUMBER($F7),$F7,$E7))')
  assert.ok(
    rules[4].includes('ROUNDDOWN((IF(ISNUMBER($F7),$F7,$E7)-$E7+1)*IF(ISNUMBER($H7),IF(MAX($H$7:$H)>1,$H7/100,$H7)'),
  )
  assert.ok(rules[5].endsWith('>=1)'), 'finished bars')
})

test('without a Start column there is nothing to chart; with only Task and Start it still works', () => {
  assert.deepEqual(
    ganttSheetRequests({
      title: 'x',
      dataTab: 'T',
      headers: ['Task'],
      fields: { task: 'Task', start: 'Start' },
      sheetId: 1,
      dataRows: 10,
    }),
    { error: 'The Sheet has no Start date column, so there is nothing to chart.' },
  )
  const small = ganttSheetRequests({
    title: 'x',
    dataTab: 'T',
    headers: ['Task', 'Start'],
    fields: { task: 'Task', start: 'Start' },
    sheetId: 1,
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
