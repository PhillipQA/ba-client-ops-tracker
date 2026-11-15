import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTimelineSettings } from '../src/features/trackers/timelineModel'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'
import { makeLookup } from '../src/features/trackers/trackerQuery'
import {
  businessHour,
  cleanReminders,
  describeReminder,
  newReminder,
  reminderDue,
  reminderKey,
  reminderPeople,
  reminderText,
} from '../src/features/trackers/trackerReminders'

const columns: TrackerColumn[] = [
  { id: 'c_site', name: 'Site', type: 'text' },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o_new', label: 'Not started', color: 'gray' },
      { id: 'o_live', label: 'Live', color: 'green' },
    ],
  },
  { id: 'c_go', name: 'Go-live', type: 'date' },
  { id: 'c_owner', name: 'Owner', type: 'person' },
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
// Sunday, Nov 15 2026; Monday is the 16th.
const today = '2026-11-16'
const lookup = { ...makeLookup([], [{ id: 'u1', name: 'Jun Perez', username: 'jun' }], today), columns }
const notLive = { columnId: 'c_status', op: 'is_not', value: 'o_live' }
const before = {
  id: 'm_before',
  dateId: 'c_go',
  when: 'before',
  days: 3,
  condition: notLive,
  to: { columnId: 'c_owner' },
}
const on = { id: 'm_on', dateId: 'c_go', when: 'on', to: { people: ['u9'], creator: true } }
const after = { id: 'm_after', dateId: 'c_go', when: 'after', condition: notLive, to: { columnId: 'c_owner' } }

test('reminders are cleaned: a date column, someone to remind, a sane number of days', () => {
  const list = cleanReminders(
    [
      before,
      { ...on, days: 99 },
      { ...after, days: 5 },
      { id: 'm_nobody', dateId: 'c_go', when: 'on', to: {} },
      { id: 'm_nodate', dateId: 'c_site', when: 'on', to: { creator: true } },
      { id: 'm_far', dateId: 'c_go', when: 'before', days: 500, to: { creator: true } },
      {
        id: 'm_badcond',
        dateId: 'c_go',
        when: 'on',
        condition: { columnId: 'c_status', op: 'is', value: '' },
        to: { creator: true },
      },
    ],
    columns,
  )
  assert.deepEqual(
    list.map(item => item.id),
    ['m_before', 'm_on', 'm_after', 'm_far', 'm_badcond'],
  )
  assert.equal(list[1].days, 0)
  assert.equal(list[2].days, 0)
  assert.equal(list[3].days, 90)
  assert.equal(list[4].condition, undefined, 'A condition without its value is dropped, the reminder kept')
  assert.equal(cleanTimelineSettings({ reminders: [before] }, columns).reminders?.length, 1)
})

test('before, on and after: due on the right days, only while the condition holds', () => {
  const [b, o, a] = cleanReminders([before, on, after], columns)
  const due = (reminder: typeof b, cells: TrackerRow['cells'], day = today) =>
    reminderDue(reminder, row('r', cells), columns, lookup, day).due
  assert.equal(due(b, { c_go: '2026-11-19', c_status: 'o_new' }), true, '3 days before')
  assert.equal(due(b, { c_go: '2026-11-20', c_status: 'o_new' }), false)
  assert.equal(due(b, { c_go: '2026-11-19', c_status: 'o_live' }), false, 'Already live: no reminder')
  assert.equal(due(o, { c_go: '2026-11-16' }), true)
  assert.equal(due(a, { c_go: '2026-11-12', c_status: 'o_new' }), true, 'Past and not live: every working day')
  assert.equal(due(a, { c_go: '2026-11-12', c_status: 'o_new' }, '2026-11-15'), false, 'Not on a Sunday')
  assert.equal(due(a, { c_go: '2026-11-16', c_status: 'o_new' }), false, 'Not on the day itself')
  assert.equal(due(o, {}), false, 'No date: nothing')
  assert.equal(due({ ...o, off: true }, { c_go: '2026-11-16' }), false)
})

test('who is reminded, and what they read', () => {
  const [b, o] = cleanReminders([before, on], columns)
  assert.deepEqual(reminderPeople(b, row('r', { c_owner: 'u1' }), columns, lookup, 'creator'), ['u1'])
  assert.deepEqual(reminderPeople(b, row('r', {}), columns, lookup, 'creator'), [])
  assert.deepEqual(reminderPeople(o, row('r', {}), columns, lookup, 'creator').sort(), ['creator', 'u9'])
  const r = row('r', { c_site: 'Festival Mall', c_go: '2026-11-19' })
  assert.deepEqual(reminderText(r, columns, b, { days: 3, date: '2026-11-19' }, 'Site rollout'), {
    title: 'Festival Mall: Go-live in 3 days',
    message: 'Go-live Nov 19, 2026 · Site rollout',
    severity: 'info',
  })
  assert.equal(
    reminderText(r, columns, b, { days: -2, date: '2026-11-14' }, 'X').title,
    'Festival Mall: Go-live was 2 days ago',
  )
  assert.equal(
    reminderText(r, columns, b, { days: 0, date: '2026-11-16' }, 'X').title,
    'Festival Mall: Go-live is today',
  )
  assert.equal(
    describeReminder(b, columns, () => ''),
    '3 days before Go-live, if Status is not Live → the row’s Owner',
  )
  assert.equal(newReminder(columns)?.to.columnId, 'c_owner')
  assert.equal(reminderKey('t', 'm', 'r', 'u', today), 'tracker-reminder:t:m:r:u:2026-11-16')
})

test('the business hour is read in the business time zone', () => {
  // 00:30 UTC is 8:30 AM in Manila.
  assert.equal(businessHour(new Date('2026-11-16T00:30:00Z'), 'Asia/Manila'), 8)
  assert.equal(businessHour(new Date('2026-11-15T23:30:00Z'), 'Asia/Manila'), 7)
})
