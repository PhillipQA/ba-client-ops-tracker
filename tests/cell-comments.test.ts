import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  cellCommentMap,
  cellEntries,
  cellKey,
  cellTaskId,
  peopleComments,
  TIP_SHOWN,
  tipOf,
  tipText,
} from '../src/features/trackers/cellComments'
import type { RowComment } from '../src/features/trackers/trackerComments'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const comment = (id: string, at: string, extra: Partial<RowComment> = {}): RowComment => ({
  id,
  authorId: 'u1',
  authorName: 'Phillip',
  text: `comment ${id}`,
  mentions: [],
  at,
  ...extra,
})

test('cell comments are grouped by cell; row comments are not on a cell', () => {
  const map = cellCommentMap([
    { ...comment('b', '2026-11-21T02:00:00Z', { columnId: 'status' }), rowId: 'r1' },
    { ...comment('a', '2026-11-21T01:00:00Z', { columnId: 'status' }), rowId: 'r1' },
    { ...comment('c', '2026-11-21T03:00:00Z', { columnId: 'qa' }), rowId: 'r1' },
    { ...comment('d', '2026-11-21T03:00:00Z'), rowId: 'r1' },
  ])
  assert.deepEqual(
    map.get(cellKey('r1', 'status'))?.map(item => item.id),
    ['a', 'b'],
    'oldest first',
  )
  assert.equal(map.get(cellKey('r1', 'qa'))?.length, 1)
  assert.equal(map.size, 2, 'the whole-row comment has no corner')
})

test('a cell’s task: the row’s Task in the first column, a linked Subtask elsewhere', () => {
  const links = new Map([['r1', new Map([['qa', { taskId: 'sub-1' }]])]])
  assert.equal(cellTaskId({ id: 'r1', taskId: 'task-1' }, 'title', 'title', links), 'task-1')
  assert.equal(cellTaskId({ id: 'r1', taskId: 'task-1' }, 'qa', 'title', links), 'sub-1')
  assert.equal(cellTaskId({ id: 'r1', taskId: 'task-1' }, 'status', 'title', links), '', 'no task: Sheets-style')
  assert.equal(cellTaskId({ id: 'r2', taskId: null }, 'title', 'title', links), '')
})

test('a task-linked cell shows its task’s comments, with any it had of its own', () => {
  const task = {
    comments: [
      {
        id: 't1',
        text: 'Retest Monday',
        createdAt: '2026-11-21T02:30:00Z',
        createdBy: 'u2',
        createdByName: 'emonding',
        kind: 'User' as const,
      },
      {
        id: 't2',
        text: 'Follow-up moved',
        createdAt: '2026-11-21T02:40:00Z',
        createdBy: 'system',
        createdByName: 'System',
        kind: 'System' as const,
      },
    ],
  }
  assert.deepEqual(
    peopleComments(task).map(item => item.id),
    ['t1'],
    'the app’s own entries are left out',
  )
  const entries = cellEntries([comment('own', '2026-11-21T01:00:00Z', { columnId: 'qa', editedAt: 'x' })], task)
  assert.deepEqual(
    entries.map(entry => [entry.id, entry.source]),
    [
      ['own', 'cell'],
      ['t1', 'task'],
    ],
  )
  assert.equal(entries[0].edited, true)
  assert.equal(entries[1].author, 'emonding')
  assert.deepEqual(cellEntries([], undefined), [])
})

test('the tooltip shows the latest few and counts the rest', () => {
  const entries = cellEntries(
    Array.from({ length: TIP_SHOWN + 3 }, (_, index) =>
      comment(String(index), `2026-11-21T0${index}:00:00Z`, { columnId: 'qa' }),
    ),
    null,
  )
  const tip = tipOf(entries)
  assert.equal(tip.shown.length, TIP_SHOWN)
  assert.equal(tip.more, 3)
  assert.equal(tip.shown.at(-1)?.id, String(TIP_SHOWN + 2), 'the newest is last')
  assert.equal(tipText('  two\n\nlines  '), 'two lines')
  assert.equal(tipText('x'.repeat(400)).length, 280)
})

test('comments are kept on their cell, and the grid offers the corner, tooltip and box', () => {
  const server = read('server/trackers/tracker-comments.ts')
  assert.match(server, /\.\.\.\(columnId \? \{ columnId \} : \{\}\)/)
  assert.match(server, /That column is no longer in this tracker/)
  assert.match(
    server,
    /\.\.\.\(entry\.detail\?\.columnId \? \{ columnId: String\(entry\.detail\.columnId\) \} : \{\}\)/,
  )
  assert.match(server, /res\.json\(\{ counts, cells \}\)/)
  const grid = read('src/features/trackers/TrackerGrid.tsx')
  assert.match(grid, /className="trk-comment-corner"/)
  assert.match(grid, /onContextMenu=/)
  assert.match(grid, /event\.ctrlKey && event\.altKey && event\.key\.toLowerCase\(\) === 'm'/)
  const box = read('src/features/trackers/CellComments.tsx')
  assert.match(box, /await addTaskComment\(task\.id, text\)/, 'a task-linked cell writes into the task')
  assert.match(box, /trackerApi\.addComment\(trackerId, rowId, \{ text, mentions, columnId \}\)/)
  const screen = read('src/features/trackers/TrackerScreen.tsx')
  assert.match(screen, /<CellCommentTip/)
  assert.match(screen, /<CellCommentBox/)
  assert.match(read('src/features/trackers/TrackerComments.tsx'), /className="trk-comment-cell"/)
})
