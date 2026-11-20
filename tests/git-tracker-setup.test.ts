import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGitGeneration, planGitGeneration } from '../src/features/trackers/gitGeneration'
import { starterGitTemplate } from '../src/features/trackers/gitStarter'
import { keepsStepTasks } from '../src/features/trackers/stepTasks'
import { mappingSuggestions, mappingTargetError } from '../server/integrations/git-mapping-rules'

test('a new GIT template starts valid: one Task for the ticket, Development and QA Subtasks under it', () => {
  const { columns, generation } = starterGitTemplate()
  assert.deepEqual(normalizeGitGeneration(generation, columns).errors, [])
  const plan = planGitGeneration({
    generation,
    columns,
    ticket: {
      provider: 'gitlab',
      repository: 'team/app',
      number: 7,
      title: 'Login fails',
      body: '',
      url: 'https://gitlab.example.com/team/app/-/issues/7',
      state: 'open',
      labels: ['bug'],
      assignees: [],
      author: 'qa',
      milestone: '',
      dueDate: '2026-12-01',
    },
    clientId: 'c1',
    projectId: 'p1',
    assigneeId: 'u1',
    idFor: (kind, key) => `${kind}-${key}`,
  })
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(
    plan.work.map(work => [work.type, work.title, work.parentId, work.dueDate]),
    [
      ['Task', '#7 Login fails', null, '2026-12-01'],
      ['Subtask', 'Development: #7 Login fails', 'work-row:ticket', '2026-12-01'],
      ['Subtask', 'QA: #7 Login fails', 'work-row:ticket', '2026-12-01'],
    ],
  )
  assert.equal(plan.rows[0].cells.c_stage, 'Ticket')
})

test('a GIT Tracker never makes tasks from rows and checkboxes', () => {
  assert.equal(keepsStepTasks({ template: 'site-rollout', kind: 'git' }), false)
  assert.equal(keepsStepTasks({ template: 'git', stepTasks: true, kind: 'git' }), false)
  assert.equal(keepsStepTasks({ template: 'site-rollout' }), true)
})

test('a repository maps to an active client and an open project of that client, or one shared by clients', () => {
  const state = {
    clients: [{ id: 'c1' }, { id: 'c2' }, { id: 'old', archived: true }],
    projects: [
      { id: 'p1', clientId: 'c1' },
      { id: 'shared' },
      { id: 'done', clientId: 'c1', seedsArchived: true },
      { id: 'gone', clientId: 'c1', archived: true },
    ],
  }
  assert.equal(mappingTargetError(state, 'c1', 'p1'), '')
  assert.equal(mappingTargetError(state, 'c2', 'shared'), '')
  assert.match(mappingTargetError(state, 'old', 'p1'), /active client/)
  assert.match(mappingTargetError(state, 'c1', 'nope'), /active project/)
  assert.match(mappingTargetError(state, 'c1', 'gone'), /active project/)
  assert.match(mappingTargetError(state, 'c1', 'done'), /completed/)
  assert.match(mappingTargetError(state, 'c2', 'p1'), /another client/)
})

test('people’s own Work Hub repository settings become suggestions, without the ones already mapped', () => {
  const suggestions = mappingSuggestions(
    [
      {
        provider: 'gitlab',
        instanceUrl: 'https://gitlab.example.com',
        userId: 'u1',
        repositories: [
          { fullName: 'team/app', clientId: 'c1', projectId: 'p1' },
          { fullName: 'team/done', clientId: 'c1', projectId: 'p1' },
          { fullName: 'team/no-client', clientId: '', projectId: '' },
        ],
      },
      {
        provider: 'gitlab',
        instanceUrl: 'https://gitlab.example.com',
        userId: 'u2',
        repositories: [
          { fullName: 'Team/App', clientId: 'c1', projectId: 'p1' },
          { fullName: 'team/app', clientId: 'c2', projectId: 'p9' },
        ],
      },
      { provider: 'github', instanceUrl: 'https://github.com', userId: 'u1', repositories: 'not a list' },
    ],
    [{ provider: 'gitlab', instanceUrl: 'https://gitlab.example.com', repository: 'TEAM/done' }],
    id => ({ u1: 'Ana', u2: 'Ben' })[id] || '',
  )
  assert.deepEqual(
    suggestions.map(item => [item.repository, item.clientId, item.projectId, item.people]),
    [
      ['team/app', 'c1', 'p1', ['Ana', 'Ben']],
      ['team/app', 'c2', 'p9', ['Ben']],
    ],
  )
})
