import test from 'node:test'
import assert from 'node:assert/strict'
import { preserveTaskSettings } from '../server/services/tenant-save-settings'

test('ordinary task edits preserve server task settings when the browser inserted a display column', () => {
  const serverSettings = { statuses: [{ id: 'open', label: 'Open', closed: false }], visibleColumns: ['status', 'dueDate'] }
  const current = { taskSettings: serverSettings, items: [{ id: 'task-1', description: 'Old' }] }
  const incoming = { taskSettings: { ...serverSettings, visibleColumns: ['status', 'startDate', 'dueDate'] }, items: [{ id: 'task-1', description: 'Edited' }] }
  const saved = preserveTaskSettings(current, incoming)
  assert.deepEqual(saved.items, incoming.items)
  assert.deepEqual(saved.taskSettings, serverSettings)
  assert.deepEqual(current, { taskSettings: serverSettings, items: [{ id: 'task-1', description: 'Old' }] })
})

test('workspace saves cannot overwrite status configuration managed by Internal Admin', () => {
  const current = { taskSettings: { statuses: [{ label: 'Open', closed: false }] }, items: [] }
  const incoming = { taskSettings: { statuses: [{ label: 'Open', closed: true }] }, items: [] }
  assert.deepEqual(preserveTaskSettings(current, incoming).taskSettings, current.taskSettings)
})
