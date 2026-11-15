import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanRules,
  describeRule,
  newRule,
  ruleOpsFor,
  ruleTone,
  ruleTones,
} from '../src/features/trackers/highlightRules'
import { cleanTimelineSettings } from '../src/features/trackers/timelineModel'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'
import { makeLookup } from '../src/features/trackers/trackerQuery'

const columns: TrackerColumn[] = [
  { id: 'c_site', name: 'Site', type: 'text' },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o_new', label: 'Not started', color: 'gray' },
      { id: 'o_live', label: 'Live', color: 'green' },
      { id: 'o_block', label: 'Blocked', color: 'red' },
    ],
  },
  { id: 'c_go', name: 'Go-live', type: 'date' },
  { id: 'c_key', name: 'Password', type: 'secret' },
]
const row = (id: string, cells: TrackerRow['cells']): TrackerRow => ({
  id,
  position: 0,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
})
const lookup = { ...makeLookup([], [], '2026-11-15'), columns }
const today = '2026-11-15'
const overdue = {
  id: 'r_overdue',
  color: 'red',
  conditions: [
    { columnId: 'c_go', op: 'past', value: '' },
    { columnId: 'c_status', op: 'is_not', value: 'o_live' },
  ],
}
const soon = { id: 'r_soon', color: 'amber', conditions: [{ columnId: 'c_go', op: 'within', value: '7' }] }
const blocked = { id: 'r_block', color: 'purple', conditions: [{ columnId: 'c_status', op: 'is', value: 'o_block' }] }

test('rules are cleaned: known columns, comparisons that fit, a colour, a value where one is needed', () => {
  const rules = cleanRules(
    [
      overdue,
      { ...soon, conditions: [{ columnId: 'c_go', op: 'within', value: '9999' }] },
      { id: 'r_bad', color: 'neon', conditions: overdue.conditions },
      { id: 'r_gone', color: 'red', conditions: [{ columnId: 'c_deleted', op: 'is', value: 'x' }] },
      { id: 'r_secret', color: 'red', conditions: [{ columnId: 'c_key', op: 'not_empty', value: '' }] },
      { id: 'r_wrong', color: 'red', conditions: [{ columnId: 'c_site', op: 'past', value: '' }] },
      { id: 'r_blank', color: 'red', conditions: [{ columnId: 'c_status', op: 'is', value: '' }] },
      { ...blocked, off: true },
    ],
    columns,
  )
  assert.deepEqual(
    rules.map(rule => rule.id),
    ['r_overdue', 'r_soon', 'r_block'],
  )
  assert.equal(rules[1].conditions[0].value, '365')
  assert.equal(rules[2].off, true)
  assert.deepEqual(cleanRules('nope', columns), [])
  assert.ok(ruleOpsFor(columns[2]).includes('past'))
  assert.ok(!ruleOpsFor(columns[0]).includes('past'))
  // Rules ride along with the timeline settings.
  assert.equal(cleanTimelineSettings({ rules: [overdue] }, columns).rules?.length, 1)
  assert.equal(cleanTimelineSettings({ rules: [] }, columns).rules, undefined)
})

test('the first rule that matches colours the row; every condition of a rule must hold', () => {
  const rules = cleanRules([overdue, soon, blocked], columns)
  const tone = (cells: TrackerRow['cells']) => ruleTone(rules, row('x', cells), columns, lookup, today)
  assert.equal(tone({ c_go: '2026-11-14', c_status: 'o_new' }), 'red', 'Past and not live')
  assert.equal(tone({ c_go: '2026-11-14', c_status: 'o_live' }), undefined, 'Past but live')
  assert.equal(tone({ c_go: '2026-11-15' }), 'amber', 'Today counts as within the next 7 days')
  assert.equal(tone({ c_go: '2026-11-22' }), 'amber')
  assert.equal(tone({ c_go: '2026-11-23' }), undefined)
  assert.equal(tone({ c_go: '2026-11-14', c_status: 'o_block' }), 'red', 'The earlier rule wins')
  assert.equal(tone({ c_status: 'o_block' }), 'purple')
  assert.equal(tone({}), undefined, 'No date is not a past date')
})

test('a rule that is off, or about a deleted column, colours nothing', () => {
  const off = cleanRules([{ ...blocked, off: true }], columns)
  assert.equal(ruleTones(off, [row('a', { c_status: 'o_block' })], columns, lookup, today).size, 0)
  const rules = cleanRules([blocked], columns)
  const without = columns.filter(column => column.id !== 'c_status')
  assert.equal(ruleTone(rules, row('a', { c_status: 'o_block' }), without, lookup, today), undefined)
  assert.deepEqual(
    [...ruleTones(rules, [row('a', { c_status: 'o_block' }), row('b', {})], columns, lookup, today)],
    [['a', 'purple']],
  )
})

test('a rule reads as a sentence, and a new rule starts on a date column', () => {
  const [rule, next] = cleanRules([overdue, soon], columns)
  assert.equal(
    describeRule(rule, columns, () => ''),
    'Go-live is before today and Status is not Live',
  )
  assert.equal(
    describeRule(next, columns, () => ''),
    'Go-live is within the next 7 days',
  )
  assert.equal(newRule(columns)?.conditions[0].columnId, 'c_go')
  assert.equal(newRule([columns[3]]), undefined)
})
