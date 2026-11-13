import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_LIMITS, agentTools, runAgent } from '../server/ai/assistant-agent'

const settings = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'done', label: 'Done', closed: true },
  ],
}
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'Open',
  waitingOn: 'Internal',
  priority: 'Medium',
  description: '',
  followUpDate: '',
  clientId: 'c1',
  projectId: 'p1',
  ...extra,
})
const state = () => ({
  taskSettings: settings,
  accounts: [
    { id: 'u1', name: 'Phillip' },
    { id: 'u2', name: 'Bea' },
  ],
  clients: [{ id: 'c1', name: 'Goldwing Retail Group Inc.' }],
  projects: [
    { id: 'p1', name: 'Makati rollout', clientId: 'c1', contractNumber: 'CN-2', seedsId: '20' },
    {
      id: 'p2',
      name: 'GOLDWING BALABALA',
      clientId: 'c1',
      contractNumber: 'CONTRACT-2026-04-1660',
      seedsArchived: true,
      seedsTimeRules: { productRequired: true },
    },
  ],
  items: [
    task('t1', {
      title: 'Go Live Makati T1',
      assignedToUserId: 'u1',
      followUpDate: '2026-11-10',
      description: 'printer setup',
    }),
    task('t2', { title: 'UAT sign-off', assignedToUserId: 'u2', dueDate: '2026-11-15' }),
    task('t3', { title: 'Old migration', status: 'Done', projectId: 'p2' }),
    task('s1', { title: 'Install printer', parentTaskId: 't1', clientId: undefined, projectId: undefined }),
    task('t4', {
      title: 'Remote assistance',
      assignedToUserId: 'u1',
      timeEntries: [
        { id: 'e1', userId: 'u1', date: '2026-11-12', hours: 1.5, forSeeds: true },
        { id: 'e2', userId: 'u1', date: '2026-11-13', hours: 1, seedsEntryId: '9' },
        { id: 'e3', userId: 'u2', date: '2026-11-13', hours: 2 },
      ],
    }),
  ],
})
const tools = (allowed: string[] = ['items', 'clients', 'projects']) =>
  agentTools({
    state: state(),
    user: { id: 'u1', name: 'Phillip' },
    allowed: m => allowed.includes(m),
    today: '2026-11-13',
  })
const tool = (list: ReturnType<typeof tools>, name: string) => {
  const found = list.find(item => item.name === name)
  assert.ok(found, name)
  return found
}

test('tools search and open the person’s work by name, client, project and contract number', async () => {
  const all = tools()
  const found: any = await tool(all, 'find_tasks').run({ client: 'goldwing', text: 'makati' })
  assert.deepEqual(
    found.tasks.map((t: any) => t.title),
    ['Go Live Makati T1'],
  )
  assert.equal(found.tasks[0].client, 'Goldwing Retail Group Inc.')
  const mine: any = await tool(all, 'find_tasks').run({ mine: true })
  assert.deepEqual(mine.tasks.map((t: any) => t.id).sort(), ['t1', 't4'])
  const done: any = await tool(all, 'find_tasks').run({ status: 'done' })
  assert.deepEqual(
    done.tasks.map((t: any) => t.id),
    ['t3'],
  )
  assert.match(((await tool(all, 'find_tasks').run({ client: 'Nobody' })) as any).error, /No client/)

  const opened: any = await tool(all, 'get_task').run({ id: 't1' })
  assert.deepEqual(
    opened.subtasks.map((t: any) => t.title),
    ['Install printer'],
  )
  assert.equal(opened.subtasks[0].project, 'Makati rollout', 'a subtask takes its parent’s project')
  assert.equal(opened.assignee, 'Phillip')

  const project: any = await tool(all, 'get_project').run({ project: 'CONTRACT-2026-04-1660' })
  assert.deepEqual(
    [project.name, project.completed, project.timeEntryRules.productRequired],
    ['GOLDWING BALABALA', true, true],
  )
  const client: any = await tool(all, 'get_client').run({ client: 'Goldwing' })
  assert.deepEqual(
    client.projects.map((p: any) => [p.name, p.completed]),
    [
      ['Makati rollout', false],
      ['GOLDWING BALABALA', true],
    ],
  )
})

test('due work and logged time are worked out from the loaded workspace', async () => {
  const all = tools()
  const due: any = await tool(all, 'due_work').run({})
  assert.deepEqual(
    due.overdue.map((t: any) => t.id),
    ['t1'],
  )
  assert.deepEqual(
    due.due.map((t: any) => t.id),
    ['t2'],
  )
  const time: any = await tool(all, 'time_logged').run({ from: '2026-11-10', to: '2026-11-13' })
  assert.deepEqual([time.hours, time.notSentToSeeds], [2.5, 1.5], 'only the person’s own by default')
  const everyone: any = await tool(all, 'time_logged').run({ from: '2026-11-10', to: '2026-11-13', mine: false })
  assert.equal(everyone.hours, 4.5)
})

test('tools follow the person’s modules: no tasks module, no task tools', () => {
  assert.deepEqual(
    tools(['clients']).map(t => t.name),
    ['get_client'],
  )
  assert.deepEqual(tools([]), [])
  // Trackers and emails only when allowed and readable.
  const withReaders = agentTools({
    state: state(),
    user: { id: 'u1', name: 'P' },
    allowed: m => m === 'trackers',
    today: '2026-11-13',
    readTracker: async () => ({}),
    searchEmails: async () => ({}),
  })
  assert.deepEqual(
    withReaders.map(t => t.name),
    ['read_tracker'],
  )
})

test('the loop looks things up, then answers; results are capped; bad tools and failures are reported', async () => {
  const replies = [
    '{"tool":"find_tasks","args":{"client":"Goldwing"}}',
    '{"tool":"nope","args":{}}',
    '```json\n{"tool":"get_task","args":{"id":"missing"}}\n```',
    '{"message":"Two open tasks for Goldwing.","followUp":"Want a summary?","suggestions":[]}',
  ]
  const prompts: string[] = []
  const ran = await runAgent({
    call: async (instructions, prompt) => {
      assert.match(instructions, /find_tasks:/)
      prompts.push(prompt)
      return replies[prompts.length - 1]
    },
    instructions: 'BASE',
    prompt: 'QUESTION',
    tools: tools(),
  })
  assert.equal(ran.output.message, 'Two open tasks for Goldwing.')
  assert.deepEqual(
    ran.steps.map(step => [step.tool, step.ok]),
    [
      ['find_tasks', true],
      ['unknown', false],
      ['get_task', false],
    ],
  )
  assert.match(prompts[1], /LOOKUPS[\s\S]*1\. find_tasks[\s\S]*Go Live Makati T1/)
  assert.match(prompts[3], /There is no tool “nope”/)

  const big = await runAgent({
    call: async (_i, prompt) => (prompt.includes('LOOKUPS') ? '{"message":"ok"}' : '{"tool":"huge","args":{}}'),
    instructions: '',
    prompt: '',
    tools: [{ name: 'huge', about: '', label: () => 'Huge', run: () => ({ rows: 'x'.repeat(50_000) }) }],
  })
  assert.equal(big.output.message, 'ok')
})

test('the loop stops looking things up after the step limit or near the time budget', async () => {
  let calls = 0
  let lastPrompt = ''
  const ran = await runAgent({
    call: async (_i, prompt) => {
      calls++
      lastPrompt = prompt
      return prompt.includes('No more lookups') ? '{"message":"done"}' : '{"tool":"find_tasks","args":{}}'
    },
    instructions: '',
    prompt: '',
    tools: tools(),
  })
  assert.equal(ran.steps.length, AGENT_LIMITS.steps)
  assert.equal(calls, AGENT_LIMITS.steps + 1)
  assert.match(lastPrompt, /No more lookups/)

  // Near the end of the time budget it must answer at once.
  let clock = 0
  const timeouts: number[] = []
  const hurried = await runAgent({
    call: async (_i, prompt, timeout) => {
      timeouts.push(timeout)
      clock += AGENT_LIMITS.budgetMs - 10_000
      return prompt.includes('No more lookups') ? '{"message":"quick"}' : '{"tool":"find_tasks","args":{}}'
    },
    instructions: '',
    prompt: '',
    tools: tools(),
    now: () => clock,
  })
  assert.equal(hurried.output.message, 'quick')
  assert.equal(hurried.steps.length, 1)
  assert.ok(timeouts.every(ms => ms <= AGENT_LIMITS.callMs))

  // A model that will not stop is an error, not an endless loop.
  await assert.rejects(
    runAgent({
      call: async () => '{"tool":"find_tasks","args":{}}',
      instructions: '',
      prompt: '',
      tools: tools(),
    }),
    /kept looking things up/,
  )
})
