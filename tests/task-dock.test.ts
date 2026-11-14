import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanDocked, dockTask, MAX_DOCKED_TASKS, undockTask } from '../src/features/tasks/taskDock'

test('up to four tasks are minimized, each once, newest last', () => {
  let docked: string[] = []
  for (const id of ['a', 'b', 'c', 'd']) docked = dockTask(docked, id).docked
  assert.deepEqual(docked, ['a', 'b', 'c', 'd'])
  const full = dockTask(docked, 'e')
  assert.match(full.problem || '', /already have 4 tasks minimized/)
  assert.deepEqual(full.docked, docked)
  assert.deepEqual(dockTask(docked, 'b').docked, ['a', 'c', 'd', 'b'], 'Minimizing it again moves it to the end')
  assert.deepEqual(undockTask(docked, 'c'), ['a', 'b', 'd'])
  assert.equal(MAX_DOCKED_TASKS, 4)
})

test('a stored dock is checked, and tasks that are gone drop off', () => {
  assert.deepEqual(cleanDocked(['a', 'a', 7, '', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd'])
  assert.deepEqual(cleanDocked(['a', 'gone', 'b'], new Set(['a', 'b'])), ['a', 'b'])
  assert.deepEqual(cleanDocked('nonsense'), [])
})
