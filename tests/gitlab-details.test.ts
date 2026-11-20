import assert from 'node:assert/strict'
import test from 'node:test'
import { dueDay, dueText, duration, involvement, priorityLabels } from '../src/features/integrations/gitlabDetails'
test('gitlab details', () => {
  assert.equal(
    involvement({ created_by_me: false, assigned_to_me: true, commented_by_me: true }),
    'Assigned to me · Commented',
  )
  assert.deepEqual(priorityLabels(['bug', 'Priority::High', 'severity::2']), { priority: 'High', severity: '2' })
  assert.deepEqual(priorityLabels(['p1']), { priority: 'P1', severity: '' })
  assert.equal(duration(5400), '1h 30m')
  assert.equal(duration(2700), '45m')
  assert.equal(dueText('2026-11-12', '2026-11-15')!.text, 'Overdue by 3 days')
  assert.equal(dueText('2026-11-16', '2026-11-15')!.text, 'Due in 1 day')
  assert.equal(dueText(null, '2026-11-15'), null)
  // The database can send the date as a full timestamp: it showed "Due Invalid Date".
  assert.equal(dueDay('2026-11-28T00:00:00.000Z'), '2026-11-28')
  assert.equal(dueText('2026-11-16T00:00:00.000Z', '2026-11-15')!.text, 'Due in 1 day')
  assert.equal(dueText('2026-12-30T00:00:00.000Z', '2026-11-15')!.text.includes('Invalid'), false)
  assert.equal(dueDay('soon'), '')
  assert.equal(dueText('soon', '2026-11-15'), null, 'an unreadable date shows nothing')
})
