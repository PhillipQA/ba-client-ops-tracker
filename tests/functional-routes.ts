import PizZip from 'pizzip'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import express from 'express'
import { transformSync } from 'esbuild'
import { registerTestCaseRoutes } from '../server/documents/testcase-documents'
import { registerFsdRoutes } from '../server/documents/fsd-documents'
import { buildAssistantContext } from '../server/ai/assistant-context'
import { addTrackers } from '../server/ai/assistant-trackers'
import { workspaceVersion, mergeActivity } from '../server/services/workspace-version'
import { runTenantAi } from '../server/ai/tenant-ai'
import { emptyFsdDraft, fsdSectionsForModules } from '../src/features/documents/fsd-model'
import { createWorkspaceGuard } from '../server/services/workspace-guard'
import { defaultTaskSettings } from '../src/app/data'
import { openWaitingOnOptions } from '../src/features/tasks/waitingOn'
import { assertRtmMutation, reconcileRtm } from '../src/features/requirements/rtm'
import { assertLifecycleMutation, LifecycleError } from '../src/features/tasks/lifecycle'
import { applySubtaskAssignmentInheritance } from '../src/features/tasks/subtaskAssignment'
import { preserveTaskSettings } from '../server/services/tenant-save-settings'
import { preserveInterfaceModes } from '../server/accounts/preferences'
import { reconcileNotifications } from '../server/services/notification-engine'
import { dateKeyInTimeZone } from '../server/services/follow-up-rollover'
import { normalizeAppTheme, normalizeClientThemes } from '../src/features/settings/theme'
import { normalizeInterfaceMode } from '../src/features/settings/appearance'

const checks: any[] = []
const record = (name: string, detail: any) => {
  checks.push({ name, detail })
  console.log(name, JSON.stringify(detail))
}
const originalFetch = globalThis.fetch
let modelReply: any = { message: 'Fixture response', suggestions: [] },
  wire: any[] = []
globalThis.fetch = (async (input: any, options: any) => {
  const url = String(input)
  if (!url.startsWith('https://')) return originalFetch(input, options)
  const body = JSON.parse(options.body)
  wire.push({ url, body })
  const text = JSON.stringify(Array.isArray(modelReply) ? modelReply.shift() : modelReply)
  const reply = url.includes('anthropic.com')
    ? { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
    : url.endsWith('/responses')
      ? {
          object: 'response',
          id: 'test',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
        }
      : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }] }
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const pass = (_r: any, _s: any, next: any) => next()
const aiAgents: any = {
  active: async () => ({
    secret: 'synthetic-fixture-key-only',
    config: { provider: 'anthropic', model: 'claude-sonnet-5' },
  }),
}
const app = express()
app.use(express.json({ limit: '10mb' }))
app.use((req: any, _res, next) => {
  req.authUser = {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'Administrator',
    modules: ['documents', 'items', 'ai', 'clients', 'projects', 'action', 'inbox', 'requirements'],
    organizationId: 'tenant',
  }
  next()
})
registerTestCaseRoutes(app, { requireAuth: pass, requireTenant: pass, aiAgents })
const templateDb: any = {
  from: () => ({
    select() {
      return this
    },
    eq() {
      return this
    },
    async maybeSingle() {
      return { data: null, error: null }
    },
  }),
}
registerFsdRoutes(app, {
  db: templateDb,
  requireAuth: pass,
  requireTenant: pass,
  aiAgents,
  logoPath: new URL('../templates/fsd-logo.png', import.meta.url).pathname,
})
const server = app.listen(0),
  address = server.address() as any,
  base = `http://127.0.0.1:${address.port}`
const post = async (path: string, body: any) => {
  const r = await originalFetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}
try {
  for (const provider of ['openai', 'gemini', 'anthropic', 'deepseek']) {
    wire = []
    modelReply = { result: 'success' }
    const text = await runTenantAi('synthetic-key', { provider, model: 'fixture-model' }, 'Instructions', 'Input')
    assert.deepEqual(JSON.parse(text), modelReply)
    record(`adapter-${provider}`, {
      responseParsed: true,
      path: new URL(wire[0].url).pathname,
      jsonSchemaRequested: !!(wire[0].body.response_format || wire[0].body.text?.format),
    })
  }
  const sources = [
    {
      id: 'SRC-001',
      name: 'requirements.txt',
      kind: 'BRD',
      text: 'REQ-001: Inventory screen shows stock. REQ-002: Approvals require a supervisor.',
    },
  ]
  const skills = [{ id: 'functional', name: 'Functional', instructions: 'Test supported requirements.' }]
  const requirements = [
    {
      id: 'REQ-001',
      title: 'Inventory screen shows stock',
      sourceIds: ['SRC-001'],
      evidence: [{ sourceId: 'SRC-001', quote: 'Inventory screen shows stock.' }],
      scenarios: ['View stock'],
    },
    {
      id: 'REQ-002',
      title: 'Supervisor approval',
      sourceIds: ['SRC-001'],
      evidence: [{ sourceId: 'SRC-001', quote: 'Approvals require a supervisor.' }],
      scenarios: ['Approve adjustment'],
    },
  ]
  modelReply = { requirements: [requirements[0], { ...requirements[1], id: 'REQ-001' }], gaps: [] }
  let result = await post('/api/documents/test-cases/coverage', { sources, skills })
  assert.equal(result.status, 422)
  record('TC duplicate requirement IDs rejected', { status: result.status })
  const oneCase = {
    id: 'TC-001',
    module: 'Inventory',
    requirementRef: 'REQ-001',
    scenario: 'View stock',
    steps: '1. Open inventory',
    expectedResult: 'Stock is displayed',
  }
  modelReply = {
    cases: [oneCase],
    coverageReview: { summary: 'All covered', coveredRequirements: 2, totalRequirements: 2, findings: [] },
  }
  result = await post('/api/documents/test-cases/generate', { sources, skills, coverage: { requirements, gaps: [] } })
  assert.equal(result.status, 200)
  assert.equal(result.body.coverageReview.coveredRequirements, 1)
  record('TC inflated model coverage recalculated', {
    status: result.status,
    actualDistinctRefs: 1,
    displayed: result.body.coverageReview,
  })
  modelReply = { ...modelReply, cases: [{ ...oneCase, requirementRef: 'REQ-001, REQ-999' }] }
  result = await post('/api/documents/test-cases/generate', { sources, skills, coverage: { requirements, gaps: [] } })
  assert.equal(result.status, 422)
  record('TC mixed known and invented references rejected', { status: result.status, error: result.body.error })
  result = await post('/api/documents/test-cases/export', {
    suiteName: 'Review fixture',
    sources,
    coverage: { requirements, gaps: [] },
    cases: [{ ...oneCase, requirementRef: 'REQ-999' }],
    coverageReview: { summary: 'Complete', coveredRequirements: 2, totalRequirements: 2 },
  })
  assert.equal(result.status, 422)
  record('TC export rejects unknown edited reference', { status: result.status, error: result.body.error })
  result = await post('/api/documents/test-cases/export', {
    suiteName: 'Fixture',
    sources,
    coverage: { requirements, gaps: [] },
    cases: [oneCase],
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.match(
    new PizZip(Buffer.from(result.body.fileData, 'base64')).file('xl/worksheets/sheet1.xml')!.asText(),
    /Stock is displayed/,
  )
  record('Valid edited test cases export to XLSX', { status: result.status })
  const draft = emptyFsdDraft()
  Object.assign(draft.details, { client: 'Fixture client', feature: 'Inventory', author: 'Reviewer' })
  draft.modules = ['MMS Report']
  draft.sources = [
    { ...sources[0], target: '', text: 'MMS Report lists stock. POS offline refunds are handled separately.' },
  ]
  const mapped = {
    requirements: [
      {
        id: 'R1',
        module: 'MMS Report',
        requirement: 'List stock',
        evidence: [{ sourceId: 'SRC-001', quote: 'MMS Report lists stock.' }],
      },
      {
        id: 'R2',
        module: 'POS Feature',
        requirement: 'Offline refunds',
        evidence: [{ sourceId: 'SRC-001', quote: 'POS offline refunds are handled separately.' }],
      },
    ],
    gaps: [],
  }
  const fsd = () => ({
    sections: fsdSectionsForModules(draft.modules).map(([id, title]) => ({
      id,
      title,
      sourceIds: [],
      blocks:
        id === 'acceptance'
          ? [
              {
                type: 'table',
                headers: ['AC ID', 'Scenario', 'Expected result'],
                rows: [['AC-1', 'View stock', 'Stock is displayed']],
                requirementIds: ['R1'],
              },
            ]
          : [
              {
                type: 'paragraph',
                text: id === 'report' ? 'TBD — report fields require confirmation' : 'List stock',
                requirementIds: ['R1'],
              },
            ],
    })),
    gaps: [],
    conflicts: [],
  })
  const bad = fsd()
  ;(bad.sections.find(s => s.id === 'functional')!.blocks[0] as any).text = 'POS must allow offline refunds.'
  modelReply = [mapped, bad]
  result = await post('/api/documents/fsd/preview', draft)
  assert.equal(result.status, 422)
  record('FSD rejects excluded behavior inside a core section', { status: result.status, error: result.body.error })
  wire = []
  modelReply = [mapped, fsd()]
  result = await post('/api/documents/fsd/preview', draft)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.requirements.length, 1)
  const writing = JSON.parse(wire[1].body.messages[0].content)
  assert.equal(writing.sources, undefined)
  assert.equal(writing.requirements.length, 1)
  record('FSD writing receives filtered cited requirements only', {
    requests: wire.length,
    requirements: writing.requirements.length,
  })
  const preview = result.body
  result = await post('/api/documents/fsd/generate', { ...draft, preview, reviewed: true })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const word = new PizZip(Buffer.from(result.body.fileData, 'base64')).file('word/document.xml')!.asText()
  assert.match(word, /Supporting excerpt/)
  assert.match(word, /MMS Report lists stock/)
  assert.ok(!word.includes('POS must allow offline refunds'))
  record('Reviewed grounded FSD exports with evidence', { status: result.status })

  // Server code is read from its modules; route handlers sit inside each module's register function.
  const serverFiles = [
    'index.ts',
    'core/auth.ts',
    'core/tenant-state.ts',
    'workspace/store-routes.ts',
    'ai/suggestions.ts',
    'ai/assistant-routes.ts',
    'services/account-guard.ts',
  ]
  const index = (
    await Promise.all(serverFiles.map(f => fs.readFile(new URL('../server/' + f, import.meta.url), 'utf8')))
  ).join('\n')
  const statement = (name: string) => {
    const found = new RegExp(`^(?:export )?((?:async )?function ${name}\\()`, 'm').exec(index)
    assert.ok(found, name)
    const start = found.index + found[0].length - found[1].length
    const end = index.indexOf('\n}', start) + 2
    return index.slice(start, end)
  }
  const route = (method: string, path: string) => {
    const start = index.indexOf(`app.${method}('${path}'`)
    assert.ok(start >= 0, path)
    const indent = index.slice(index.lastIndexOf('\n', start) + 1, start)
    const end = index.indexOf('\n' + indent + '})', start) + indent.length + 3
    return index.slice(start, end)
  }
  const mount = (code: string, deps: any) =>
    Function(
      ...Object.keys(deps),
      transformSync(code, { loader: 'ts', target: 'es2022', format: 'esm' }).code,
    )(...Object.values(deps))
  const task = (id: string, extra: any = {}) => ({
    id,
    title: id,
    type: 'Task',
    status: 'Open',
    priority: 'Medium',
    waitingOn: 'Me',
    owner: '',
    clientId: 'client',
    projectId: 'project',
    dateRaised: '2026-09-01',
    followUpDate: '',
    dueDate: '',
    description: '',
    resolution: '',
    source: 'Internal',
    ...extra,
  })
  const state = () => ({
    schemaVersion: 6,
    clients: [{ id: 'client', name: 'Client', status: 'Active', contact: '', email: '', health: 'Good', notes: '' }],
    projects: [{ id: 'project', name: 'Project', status: 'Active', summary: '', targetDate: '' }],
    items: [],
    activity: [],
    planner: [],
    workEvents: [],
    accounts: [],
    notifications: [],
    rtms: [],
    taskSettings: defaultTaskSettings,
  })
  let workspace: any = state()
  workspace.items = Array.from({ length: 161 }, (_, i) =>
    task(`task-${i}`, {
      assignedToUserId: 'reviewer',
      priority: i === 160 ? 'Urgent' : 'Medium',
      description: i === 160 ? 'Critical missing legacy follow-up' : '',
    }),
  )
  mount(
    [
      statement('allowedWaitingOn'),
      statement('sanitizeSuggestions'),
      statement('parseModelJson'),
      route('post', '/api/assistant'),
    ].join('\n'),
    {
      app,
      openWaitingOnOptions,
      buildAssistantContext,
      addTrackers,
      deps: {},
      requireAuth: pass,
      requireTenantWorkspace: pass,
      moduleAllowed: (u: any, m: string) => u.modules.includes(m),
      aiAgents,
      tenantIdForUser: (u: any) => u.organizationId,
      dateKeyInTimeZone,
      followUpTimeZone: 'Asia/Manila',
      ensureTenantFollowUpsCurrent: async () => ({ data: workspace }),
      emptyTenantData: state,
      defaultTaskSettings,
      runTenantAi,
      allowedKinds: new Set(['issue', 'requirement', 'follow_up', 'activity', 'draft_reply']),
      allowedPriorities: new Set(['Low', 'Medium', 'High', 'Urgent']),
      allowedWaiting: new Set(['Me', 'Developer', 'Client', 'QA', 'Design']),
    },
  )
  wire = []
  modelReply = { message: 'Fixture assistant result', suggestions: [] }
  result = await post('/api/assistant', { message: 'What urgent work should I follow up?', context: {}, history: [] })
  assert.equal(result.status, 200)
  const assistantInput = wire[0].body.messages[0].content
  const context = JSON.parse(assistantInput.split('TRACKER CONTEXT:\n')[1].split('\n\nRECENT CHAT:')[0])
  record('BA Assistant retrieves urgent older tasks and declares coverage', {
    stored: workspace.items.length,
    openItems: context.openItems.length,
    myAssignments: context.myAssignments.length,
    urgentTaskIncluded: assistantInput.includes('Critical missing legacy follow-up'),
    hasCoverageMetadata: !!context.coverage,
    partial: context.coverage.partial,
  })
  assert.equal(assistantInput.includes('Critical missing legacy follow-up'), true)
  assert.equal(context.coverage.totalItems, 161)
  assert.equal(context.coverage.partial, true)
  assert.match(result.body.message, /Context is partial/)
  workspace = state()
  workspace.items = [task('A', { priority: 'Medium' }), task('B')]
  const originalSnapshot = structuredClone(workspace)
  workspace.items[0].priority = 'High'
  workspace.items.push(task('C-created-in-other-tab'))
  const stale = structuredClone(originalSnapshot)
  stale.items[1].description = 'User edits B only'
  const guard = createWorkspaceGuard(async () => structuredClone(workspace), state as any)
  class TenantSaveError extends Error {
    constructor(
      m: string,
      public status: number,
    ) {
      super(m)
    }
  }
  mount(
    [
      statement('stable'),
      statement('accountDefaults'),
      statement('prepareAccountPasswords'),
      statement('accountChangesAreSelfOnly'),
      statement('authoritativeWorkEvents'),
      route('put', '/api/store'),
    ].join('\n'),
    {
      app,
      workspaceVersion,
      mergeActivity,
      requireAuth: pass,
      requireTenantWorkspace: pass,
      db: {},
      tenantIdForUser: (u: any) => u.organizationId,
      ensureTenantFollowUpsCurrent: async () => ({ data: structuredClone(workspace), changes: [] }),
      defaultTaskSettings,
      preserveTaskSettings,
      preserveInterfaceModes,
      normalizeAppTheme,
      normalizeClientThemes,
      normalizeInterfaceMode,
      applySubtaskAssignmentInheritance,
      TenantSaveError,
      LifecycleError,
      reconcileNotifications,
      dateKeyInTimeZone,
      followUpTimeZone: 'Asia/Manila',
      moduleAllowed: (u: any, m: string) => u.modules.includes(m),
      multiTenantSchemaReady: async () => false,
      assertLifecycleMutation,
      organizationById: async () => ({ id: 'tenant' }),
      sessions: new Map(),
      ALL_MODULES: [],
      commitTenantState: async (id: string, next: any, actor: any, _reason: any, before: any) =>
        guard(id, next, actor, before, async current => {
          assertRtmMutation(current, next, actor)
          workspace = structuredClone(reconcileRtm(current as any, next, actor))
          return { syncedAt: new Date().toISOString() }
        }),
    },
  )
  const r = await originalFetch(base + '/api/store', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: stale, baseVersion: workspaceVersion(originalSnapshot) }),
  })
  const saved = await r.json()
  assert.equal(r.status, 409, JSON.stringify(saved))
  assert.equal(workspace.items[0].priority, 'High')
  assert.equal(workspace.items.length, 3)
  record('Stale browser snapshot rejected without altering newer work', {
    httpStatus: r.status,
    priorityBefore: 'High',
    priorityAfter: workspace.items[0].priority,
    newTaskRetained: workspace.items.some((x: any) => x.id === 'C-created-in-other-tab'),
    editedB: workspace.items[1].description,
  })
  const fresh = structuredClone(workspace)
  fresh.items[1].description = 'Reapplied B edit'
  const ok = await originalFetch(base + '/api/store', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: fresh, baseVersion: workspaceVersion(workspace) }),
  })
  assert.equal(ok.status, 200, JSON.stringify(await ok.json()))
  assert.equal(workspace.items[1].description, 'Reapplied B edit')
  assert.equal(workspace.items.length, 3)
  record('Fresh revision saves successfully', { status: ok.status })
  // Drive links are written only by the save-to-Drive API; a browser save can neither drop nor forge them.
  workspace.items[1].driveFiles = [
    {
      id: 'drv-1',
      name: 'survey.pdf',
      url: 'https://drive.google.com/file/d/drv-1/view',
      mimeType: 'application/pdf',
      size: 1,
      savedAt: '2026-10-23T00:00:00Z',
      savedBy: 'u',
      savedByName: 'U',
    },
  ]
  const forged = structuredClone(workspace)
  forged.items[1].driveFiles = [{ id: 'evil', name: 'x', url: 'javascript:alert(1)' }]
  forged.items[0].driveFiles = [{ id: 'evil-2' }]
  forged.items[1].description = 'Edit beside forged links'
  const kept = await originalFetch(base + '/api/store', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: forged, baseVersion: workspaceVersion(workspace) }),
  })
  assert.equal(kept.status, 200, JSON.stringify(await kept.json()))
  assert.equal(workspace.items[1].description, 'Edit beside forged links')
  assert.deepEqual(
    workspace.items[1].driveFiles.map((f: any) => f.id),
    ['drv-1'],
  )
  assert.deepEqual(workspace.items[0].driveFiles, [])
  record('Browser saves keep server-written Drive links', { status: kept.status })
} finally {
  globalThis.fetch = originalFetch
  server.close()
}
