import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  blockedBy,
  blockedText,
  blockerChoices,
  blockerIds,
  blockersOf,
  cleanBlockers,
  createsLoop,
  dependencyLinks,
  MAX_BLOCKERS,
  openBlockersOf,
} from '../src/features/tasks/dependencies'
import {
  cleanSavedViews,
  itemsByDay,
  MAX_SAVED_VIEWS,
  monthGrid,
  shiftMonth,
  spanOf,
  timelineRange,
  timelineRows,
  viewSummary,
} from '../src/features/tasks/taskViews'
import type { TaskSettings, WorkItem } from '../src/shared/types'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const settings = {
  statuses: [
    { label: 'Open', closed: false },
    { label: 'In Progress', closed: false },
    { label: 'Done', closed: true },
  ],
} as unknown as TaskSettings
const task = (id: string, extra: Partial<WorkItem> = {}) =>
  ({ id, title: `Task ${id}`, status: 'Open', followUpDate: '', ...extra }) as WorkItem

test('blockers: stored ids cleaned, deleted tasks ignored, closed ones are not holding anything up', () => {
  const items = [
    task('a', { blockedBy: ['b', 'c', 'b', 'gone', '' as string, 5 as unknown as string] }),
    task('b', { status: 'Done' }),
    task('c'),
  ]
  assert.deepEqual(blockerIds(items[0]), ['b', 'c', 'gone'])
  assert.deepEqual(
    blockersOf(items[0], items).map(item => item.id),
    ['b', 'c'],
  )
  assert.deepEqual(
    openBlockersOf(items[0], items, settings).map(item => item.id),
    ['c'],
  )
  assert.deepEqual(
    blockedBy('c', items).map(item => item.id),
    ['a'],
  )
  assert.equal(blockedText([items[2]]), 'Blocked by Task c')
  assert.equal(blockedText([items[1], items[2]]), 'Blocked by 2 tasks')
  assert.equal(blockedText([]), '')
})

test('no task blocks itself and no loops: A blocked by B blocked by C cannot make C blocked by A', () => {
  const items = [task('a', { blockedBy: ['b'] }), task('b', { blockedBy: ['c'] }), task('c'), task('d')]
  assert.equal(createsLoop('c', 'a', items), true, 'a waits on b, which waits on c')
  assert.equal(createsLoop('c', 'd', items), false)
  assert.equal(createsLoop('d', 'd', items), true)
  assert.deepEqual(cleanBlockers('c', ['a', 'd', 'c', 'missing', 'd'], items), ['d'])
  assert.deepEqual(
    blockerChoices(items[2], [], items).map(item => item.id),
    ['d'],
    'a and b would close a loop; c is itself',
  )
  const many = Array.from({ length: 30 }, (_, at) => task(`t${at}`))
  assert.equal(
    cleanBlockers(
      'x',
      many.map(item => item.id),
      [...many, task('x')],
    ).length,
    MAX_BLOCKERS,
  )
})

test('the Timeline draws arrows only between tasks it shows', () => {
  const items = [task('a', { blockedBy: ['b', 'hidden'] }), task('b')]
  assert.deepEqual(dependencyLinks(items), [{ from: 'b', to: 'a' }])
})

test('saved views: malformed ones dropped, names unique, defaults filled, at most 30', () => {
  const views = cleanSavedViews([
    {
      id: 'v1',
      name: ' My overdue ',
      layout: 'timeline',
      group: 'waiting',
      subtasks: true,
      calendarDate: 'followUp',
      filters: { query: 'login', status: 'Open', date: 'overdue', waiting: 'Developer' },
    },
    { id: 'v2', name: 'my overdue' },
    { id: 'v3', name: 'Odd', layout: 'gantt', filters: { date: 'someday' } },
    { name: 'No id' },
    'nonsense',
  ])
  assert.equal(views.length, 2)
  assert.deepEqual(views[0], {
    id: 'v1',
    name: 'My overdue',
    layout: 'timeline',
    group: 'waiting',
    subtasks: true,
    calendarDate: 'followUp',
    filters: { query: 'login', status: 'Open', client: '', project: '', date: 'overdue', waiting: 'Developer' },
  })
  assert.equal(views[1].layout, 'table')
  assert.equal(views[1].filters.date, 'All')
  assert.equal(views[1].filters.waiting, 'All')
  assert.equal(viewSummary(views[0]), 'Timeline · Status: Open · Waiting on: Developer · overdue · “login”')
  assert.equal(
    cleanSavedViews(Array.from({ length: 40 }, (_, at) => ({ id: `v${at}`, name: `View ${at}` }))).length,
    MAX_SAVED_VIEWS,
  )
  assert.deepEqual(cleanSavedViews(null), [])
})

test('the Calendar: whole weeks, Sunday first, and tasks on their due or follow-up day', () => {
  const november = monthGrid('2026-11')
  assert.equal(november[0][0], '2026-11-01', 'Nov 1, 2026 is a Sunday')
  assert.equal(november.at(-1)?.[6], '2026-12-05')
  assert.equal(november.length, 5)
  assert.equal(monthGrid('2026-02').length, 4, 'February 2026 starts on a Sunday and has 28 days')
  assert.equal(monthGrid('2026-08')[0][0], '2026-07-26')
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  const items = [
    task('a', { dueDate: '2026-11-23', followUpDate: '2026-11-20' }),
    task('b', { dueDate: '2026-11-23' }),
    task('c', { dueDate: 'soon' }),
  ]
  assert.deepEqual(
    itemsByDay(items, 'due')
      .get('2026-11-23')
      ?.map(item => item.id),
    ['a', 'b'],
  )
  assert.deepEqual([...itemsByDay(items, 'followUp').keys()], ['2026-11-20'])
})

test('the Timeline: bars from start to due, markers for one date, subtasks under their task', () => {
  assert.deepEqual(spanOf({ startDate: '2026-11-02', dueDate: '2026-11-06' }), {
    start: '2026-11-02',
    end: '2026-11-06',
    milestone: false,
  })
  assert.deepEqual(spanOf({ dueDate: '2026-11-06' }), { start: '2026-11-06', end: '2026-11-06', milestone: true })
  assert.deepEqual(spanOf({ startDate: '2026-11-09', dueDate: '2026-11-06' })?.start, '2026-11-06')
  assert.equal(spanOf({}), null)
  const items = [
    task('late', { startDate: '2026-12-01', dueDate: '2026-12-05' }),
    task('sub', { parentTaskId: 'early', dueDate: '2026-11-03' }),
    task('early', { startDate: '2026-11-01', dueDate: '2026-11-10' }),
    task('none'),
  ]
  assert.deepEqual(
    timelineRows(items).map(row => [row.item.id, row.depth]),
    [
      ['early', 0],
      ['sub', 1],
      ['late', 0],
    ],
  )
  const range = timelineRange(
    timelineRows(items).map(row => row.span),
    '2026-11-23',
  )
  assert.equal(range.start, '2026-11-01', 'from the Sunday on or before the first bar')
  assert.ok(range.days >= 35)
})

test('wiring: four layouts, saved views on the server, dependencies in the editor, table, board and history', () => {
  const page = read('src/features/tasks/TasksPage.tsx')
  assert.match(page, /<TaskCalendar/)
  assert.match(page, /<TaskTimeline/)
  assert.match(page, /chooseTaskView\(\{ layout: 'calendar' \}\)/)
  assert.match(page, /chooseTaskView\(\{ layout: 'timeline' \}\)/)
  assert.match(page, /useSavedTaskViews\(/)
  assert.match(read('src/app/state/useCloudSync.ts'), /TASK_LAYOUTS\.find\(layout => layout === saved\.layout\)/)
  const forms = read('src/features/tasks/TaskForms.tsx')
  assert.match(forms, /<BlockedByField/)
  assert.match(forms, /cleanBlockers\(item\.id, blockers, store\.items\)/)
  assert.match(read('src/features/tasks/TaskTable.tsx'), /<BlockedBadge/)
  assert.match(read('src/features/tasks/TaskBoard.tsx'), /<BlockedBadge/)
  assert.match(read('server/core/tenant-state.ts'), /\['blockedBy', 'blocked-by tasks'\]/)
  assert.match(read('server/index.ts'), /registerTaskViewRoutes\(app, \{ store: createPreferenceStore\(db\) \}\)/)
  // Dependencies are shown, not enforced: closing and status changes are unchanged.
  for (const file of ['src/features/tasks/lifecycle.ts', 'src/features/tasks/closeSubtasks.ts'])
    assert.doesNotMatch(read(file), /blockedBy|dependencies/, file)
})
