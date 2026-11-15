import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanLayout } from '../src/shared/actionCenterLayout'
import { cleanLink, weeklyHoursOf } from '../src/shared/actionCenterSettings'
import { followUpsDue, lateness, timeThisWeek, weekDays } from '../src/features/action-center/widgetData'
import { changeSummary } from '../src/features/trackers/trackerChangeSummary'

const today = '2026-11-18' // a Wednesday

test('my time this week: Monday to Sunday against a weekly target of 40 unless changed', () => {
  assert.deepEqual(
    weekDays(today).map(day => day.date),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'],
  )
  const items = [
    {
      timeEntries: [
        { userId: 'u1', date: '2026-11-16', hours: 7.5, forSeeds: true },
        { userId: 'u1', date: '2026-11-16', hours: 1, seedsEntryId: 's1', forSeeds: true },
        { userId: 'u1', date: '2026-11-18', hours: 6 },
        { userId: 'u2', date: '2026-11-18', hours: 9 },
        { userId: 'u1', date: '2026-11-09', hours: 3, forSeeds: true },
      ],
    },
  ] as any[]
  const week = timeThisWeek(items, 'u1', today, weeklyHoursOf(undefined))
  assert.equal(week.target, 40)
  assert.equal(week.daily, 8)
  assert.equal(week.total, 14.5)
  assert.deepEqual(
    week.days.slice(0, 3).map(day => day.hours),
    [8.5, 0, 6],
  )
  assert.equal(week.unsentEntries, 2, 'unsent from any week')
  assert.equal(week.unsentHours, 10.5)
  assert.equal(weeklyHoursOf({ weeklyHours: 32.3 }), 32.5)
  assert.equal(weeklyHoursOf({ weeklyHours: 0 }), 40)
  const layout = cleanLayout([
    { id: 'time', width: 'half', settings: { weeklyHours: 36 } },
    { id: 'links', width: 'half', settings: { links: [{ label: 'Seeds', url: 'seeds.example.com' }], note: ' hi ' } },
  ])!
  assert.deepEqual(layout[0].settings, { weeklyHours: 36 })
  assert.deepEqual(layout[1].settings, { links: [{ label: 'Seeds', url: 'https://seeds.example.com/' }], note: 'hi' })
})

test('quick links: web addresses only', () => {
  assert.equal(cleanLink({ label: 'x', url: 'javascript:alert(1)' }), null)
  assert.equal(cleanLink({ label: 'x', url: 'ftp://files' }), null)
  assert.deepEqual(cleanLink({ url: 'http://intranet.local/a' }), {
    label: 'intranet.local',
    url: 'http://intranet.local/a',
  })
})

test('follow-ups due: today and before, oldest first', () => {
  const open = [
    { id: 'a', title: 'B', followUpDate: '2026-11-18', priority: 'Low' },
    { id: 'b', title: 'A', followUpDate: '2026-11-18', priority: 'High' },
    { id: 'c', title: 'C', followUpDate: '2026-11-15', priority: 'Low' },
    { id: 'd', title: 'D', followUpDate: '2026-11-19', priority: 'Urgent' },
    { id: 'e', title: 'E', followUpDate: '', priority: 'Urgent' },
  ] as any[]
  assert.deepEqual(
    followUpsDue(open, today).map(item => item.id),
    ['c', 'b', 'a'],
  )
  assert.equal(lateness('2026-11-15', today), '3 days late')
  assert.equal(lateness('2026-11-17', today), 'Yesterday')
  assert.equal(lateness(today, today), 'Today')
})

test('recent tracker changes in one line', () => {
  assert.equal(
    changeSummary('cells', {
      cells: [
        { name: 'Status', to: 'Live' },
        { name: 'Done', to: 'true' },
      ],
    }),
    'set Status to “Live” and 1 more',
  )
  assert.equal(
    changeSummary('cells', { cells: [{ name: 'Owner', to: 'u2', person: true }] }, id => (id === 'u2' ? 'Jun' : id)),
    'set Owner to “Jun”',
  )
  assert.equal(changeSummary('comment', { text: 'Lessor still waiting' }), 'commented: “Lessor still waiting”')
  assert.equal(changeSummary('automation', { done: ['set Go-live'] }), 'automation: set Go-live')
})
