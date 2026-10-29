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

test('the Gantt tab is laid out like the schedule template: phase headings over their tasks, from one live formula', () => {
  const requests = build()
  const sheet = requests[0].addSheet.properties
  assert.equal(sheet.title, GANTT_TAB)
  assert.equal(sheet.gridProperties.frozenRowCount, 6)
  assert.equal(sheet.gridProperties.frozenColumnCount, 2, 'WBS and Task stay in view')
  // Left: WBS, TASK, LEAD, START, END, % DONE, REMARKS, (hidden marker), DAYS → the chart starts in column J.
  assert.equal(sheet.gridProperties.columnCount, 9 + 182)
  const rows = requests[1].updateCells.rows.map((row: any) => row.values)
  const list = rows[5][0].userEnteredValue.formulaValue as string
  assert.ok(list.startsWith("=LET(k,'Tracker'!$A$2:$A,"), list)
  assert.ok(list.includes('hd,HSTACK("WBS","TASK","LEAD","START","END","% DONE","REMARKS","")'))
  assert.ok(
    list.includes(
      "dt,FILTER(HSTACK('Tracker'!$B$2:$B,'Tracker'!$A$2:$A,'Tracker'!$D$2:$D,'Tracker'!$F$2:$F,'Tracker'!$G$2:$G,",
    ),
    'the columns in the template’s order',
  )
  assert.ok(list.includes('MAP(pr,LAMBDA(v,IF(ISNUMBER(v),IF(mx>1,v/100,v),"")))'), '% done as a fraction either way')
  assert.ok(list.includes('rp,FILTER(\'Tracker\'!$C$2:$C,k<>"")'), 'grouped by Phase')
  assert.ok(
    list.includes('VSTACK(acc,HSTACK(i,g,"","","","","","P"),FILTER(dt,rp=g))'),
    'a numbered heading row per phase',
  )
  assert.ok(list.includes('IF(SUMPRODUCT(--(rp=""))=0,acc,VSTACK(acc,FILTER(dt,rp="")))'), 'tasks with no phase last')
  assert.equal(
    rows[6][8].userEnteredValue.formulaValue,
    '=ARRAYFORMULA(IF(ISNUMBER(D7:D)*ISNUMBER(E7:E)=0,,NETWORKDAYS(D7:D,E7:E)))',
    'working days',
  )
  assert.equal(rows[5][8].userEnteredValue.stringValue, 'DAYS')
  const formats = requests.filter((r: any) => r.repeatCell).map((r: any) => r.repeatCell)
  const dates = formats.filter((f: any) => f.cell.userEnteredFormat.numberFormat?.type === 'DATE')
  assert.deepEqual(
    dates.map((f: any) => [f.range.startColumnIndex, f.range.startRowIndex, f.range.endRowIndex]),
    [
      [3, 6, 1246],
      [4, 6, 1246],
    ],
    'Start and End are dates on every row, not serial numbers',
  )
  assert.ok(formats.some((f: any) => f.cell.userEnteredFormat.numberFormat?.type === 'PERCENT'))
  const hidden = requests.find((r: any) => r.updateDimensionProperties?.properties.hiddenByUser)
  assert.equal(hidden.updateDimensionProperties.range.startIndex, 7, 'the marker column is hidden')
  assert.equal(
    rows[1][2].userEnteredValue.formulaValue,
    "=IF(COUNT('Tracker'!$F$2:$F)=0,TODAY(),MIN('Tracker'!$F$2:$F))",
  )
  assert.equal(rows[4][9].userEnteredValue.formulaValue, '=($C$2-WEEKDAY($C$2,2)+1)+7*($E$2-1)')
  assert.equal(rows[2][9].userEnteredValue.formulaValue, '=TEXT(J$5,"mmmm yyyy")', 'month and year')
  assert.equal(requests.filter((r: any) => r.mergeCells).length, 52)
})

test('bars, phase bands and template colours are conditional formatting', () => {
  const rules = build()
    .filter((r: any) => r.addConditionalFormatRule)
    .map((r: any) => r.addConditionalFormatRule.rule)
  const formulas = rules.map((rule: any) => rule.booleanRule.condition.values[0].userEnteredValue)
  assert.equal(formulas[0], '=WEEKDAY(J$5,2)>5')
  assert.equal(formulas[2], '=AND(ISNUMBER($D7),J$5>=$D7,J$5<=IF(ISNUMBER($E7),$E7,$D7))')
  assert.ok(
    formulas[4].includes('IF(OR($G7="Done",$G7="Completed",$G7="Complete"),1,IF(ISNUMBER($F7),$F7,0))'),
    'a Done status counts as finished even at 0%',
  )
  const phase = rules.filter((rule: any) => rule.booleanRule.condition.values[0].userEnteredValue === '=$H7="P"')
  assert.equal(phase.length, 2, 'phase rows banded across the list and the chart')
  const band = phase.find((rule: any) => rule.ranges[0].startColumnIndex === 0)
  assert.equal(band.booleanRule.format.textFormat.bold, true, 'and bold')
  assert.ok(formulas.includes('=OR($G7="Done",$G7="Completed",$G7="Complete")'), 'Done remarks coloured')
  assert.ok(formulas.includes('=$G7="Ongoing"'))
  assert.ok(formulas.includes('=AND(ISNUMBER($F7),$F7>=1)'), '100% coloured')
})

test('without a Phase column the list is the tasks as they are', () => {
  const out = ganttSheetRequests({
    title: 'x',
    dataTab: 'T',
    headers: ['Task', 'Start', 'End'],
    fields: { task: 'Task', start: 'Start', end: 'End' },
    sheetId: 1,
    dataRows: 10,
  }) as any
  assert.equal(
    out.requests[1].updateCells.rows[5].values[0].userEnteredValue.formulaValue,
    '=LET(k,\'T\'!$A$2:$A,dt,FILTER(HSTACK(\'T\'!$A$2:$A,\'T\'!$B$2:$B,\'T\'!$C$2:$C,MAP(k,LAMBDA(v,""))),k<>""),hd,HSTACK("TASK","START","END",""),VSTACK(hd,dt))',
  )
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
