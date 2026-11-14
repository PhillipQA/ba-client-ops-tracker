import assert from 'node:assert/strict'
import test from 'node:test'
import type { Client, Project } from '../src/shared/types'
import { clientOfProject, projectChoices, projectOfTask } from '../src/features/tasks/projectChoices'

const clients = [
  { id: 'milano', name: 'Milano Cosmetics, Inc.', seedsId: '7' },
  { id: 'bpi', name: 'BPI' },
] as Client[]
const projects = [
  { id: 'festival', name: 'New Store: Festival Mall', clientId: 'milano', seedsId: '1', contractNumber: 'SLSS-881' },
  { id: 'old', name: 'Old rollout', clientId: 'bpi' },
  { id: 'done', name: 'Done project', clientId: 'milano', seedsId: '2', seedsArchived: true },
] as Project[]

test('projects are listed across clients, with contract number and client to search by', () => {
  const choices = projectChoices(projects, clients, '', 'Choose a project')
  assert.equal(choices[0].label, 'Choose a project')
  const festival = choices.find(choice => choice.value === 'festival')!
  assert.equal(festival.group, 'From Seeds')
  assert.equal(festival.hint, 'SLSS-881 · Milano Cosmetics, Inc.')
  assert.equal(choices.find(choice => choice.value === 'old')?.hint, 'BPI')
  // A completed Seeds project is not offered, unless it is the one already chosen.
  assert.ok(!choices.some(choice => choice.value === 'done'))
  assert.ok(projectChoices(projects, clients, '', 'x', 'done').some(choice => choice.value === 'done'))
})

test('the project brings its client, and a subtask belongs to its parent task’s project', () => {
  assert.equal(clientOfProject(projects, 'festival'), 'milano')
  assert.equal(clientOfProject(projects, ''), '')
  const items = [
    { id: 't1', projectId: 'festival' },
    { id: 's1', projectId: '', parentTaskId: 't1' },
  ]
  assert.equal(projectOfTask(items, 't1'), 'festival')
  assert.equal(projectOfTask(items, 's1'), 'festival')
  assert.equal(projectOfTask(items, 'missing'), '')
})
