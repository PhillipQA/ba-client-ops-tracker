import assert from 'node:assert/strict'
import test from 'node:test'
import { contractHint, drfContractProject, nextContract, sameContract } from '../src/features/documents/drfContract'
import type { Project, WorkItem } from '../src/shared/types'

const project = (id: string, contractNumber?: string) =>
  ({ id, name: `Project ${id}`, status: 'Active', targetDate: '', summary: '', contractNumber }) as Project
const item = (id: string, projectId: string, parentTaskId?: string) => ({ id, projectId, parentTaskId }) as WorkItem
const projects = [project('a', 'SLSS-001'), project('b', 'SLSS-002'), project('c')]
const items = [item('t1', 'a'), item('t2', 'b'), item('s1', '', 't2'), item('t3', 'c')]

test('the contract comes from the task, its parent task, or the project picked on its own', () => {
  assert.equal(drfContractProject(projects, items, 't1')?.id, 'a')
  assert.equal(drfContractProject(projects, items, 's1')?.id, 'b')
  assert.equal(drfContractProject(projects, items, '', 'b')?.id, 'b')
  // A chosen task wins over the project filter.
  assert.equal(drfContractProject(projects, items, 't1', 'b')?.id, 'a')
  assert.equal(drfContractProject(projects, items, ''), undefined)
})

test('a filled-in number follows the selection; a typed one stays', () => {
  let step = nextContract('', '', 'SLSS-001')
  assert.deepEqual(step, { value: 'SLSS-001', auto: 'SLSS-001' })
  // Another task: the app's number is replaced, not kept.
  step = nextContract(step.value, step.auto, 'SLSS-002')
  assert.deepEqual(step, { value: 'SLSS-002', auto: 'SLSS-002' })
  // A project with no number: the other project's number is cleared.
  step = nextContract(step.value, step.auto, '')
  assert.deepEqual(step, { value: '', auto: '' })
  // Typed by hand: kept whatever is picked.
  assert.deepEqual(nextContract('MY-123', 'SLSS-001', 'SLSS-002'), { value: 'MY-123', auto: 'SLSS-001' })
})

test('a number drafted from an email gives way to Seeds, and comes back when Seeds has none', () => {
  const seeds = nextContract('EMAIL-9', 'EMAIL-9', 'SLSS-001', 'EMAIL-9')
  assert.deepEqual(seeds, { value: 'SLSS-001', auto: 'SLSS-001' })
  assert.deepEqual(nextContract(seeds.value, seeds.auto, '', 'EMAIL-9'), { value: 'EMAIL-9', auto: 'EMAIL-9' })
  assert.deepEqual(nextContract('EMAIL-9', 'EMAIL-9', '', 'EMAIL-9'), { value: 'EMAIL-9', auto: 'EMAIL-9' })
})

test('the hint says where the number came from, or warns when it differs from Seeds', () => {
  assert.equal(contractHint({ value: '' }), undefined)
  assert.deepEqual(contractHint({ value: 'slss-001 ', project: projects[0] }), {
    tone: 'ok',
    text: 'From Seeds: Project a.',
  })
  assert.match(contractHint({ value: 'SLSS-001', project: projects[0], fromEmail: 'X-9' })!.text, /email said X-9/)
  const differs = contractHint({ value: 'MY-123', project: projects[0] })!
  assert.equal(differs.tone, 'warn')
  assert.equal(differs.useSeeds, 'SLSS-001')
  assert.equal(contractHint({ value: '', project: projects[2] })!.tone, 'info')
  assert.ok(sameContract('SLSS 001', 'slss001'))
})
