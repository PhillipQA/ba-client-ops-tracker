import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { newPhases, assertRtmMutation, reviseMatrix, reconcileRtm, type RtmMatrix, type RtmStore } from '../src/rtm'
import { defaultTaskSettings } from '../src/data'
import { validateRtmSources, validateRtmAiOutput, applyRtmAiSelection, type RtmAiPreview } from '../src/rtm-ai'
import { registerRtmAiRoutes } from '../server/documents/rtm-ai'

const sources = [
  { id: 'brd', name: 'Client BRD.docx', kind: 'BRD' as const, text: 'BR-01: Customers can reset their password by email.' },
  { id: 'fsd', name: 'External FSD.pdf', kind: 'FSD' as const, text: '4.2 Password reset: Send a time-limited link to the registered email address.' },
  { id: 'tc', name: 'Client QA.xlsx', kind: 'Test cases' as const, text: 'TC-01: Confirm that requesting a reset sends an email. TC-02: Reject an expired link.' },
]
function matrix(): RtmMatrix { return { id: 'rtm', name: 'Reset password', clientId: 'client', projectId: 'project', enhancement: '', contract: '', version: '1', ownerId: '', environment: 'UAT', status: 'Draft', revision: 1, nextRequirementNumber: 1, createdAt: '', updatedAt: '', history: [], requirements: [] } }
function output() { return { candidates: [{ key: 'R1', parentKey: '', title: 'Reset password by email', description: 'Allow customers to reset their password.', priority: 'Medium', existingRequirementId: '', matchReason: 'The BRD behavior is specified in the FSD and covered by TC-01.', warnings: [], evidence: [{ sourceId: 'brd', reference: 'BR-01', excerpt: 'Customers can reset their password by email.' }, { sourceId: 'fsd', reference: '4.2 Password reset', excerpt: 'Send a time-limited link to the registered email address.' }, { sourceId: 'tc', reference: 'TC-01', excerpt: 'Confirm that requesting a reset sends an email.' }] }], gaps: ['No approval evidence provided.'], conflicts: [] } }
function preview(m = matrix()): RtmAiPreview { return { ...validateRtmAiOutput(output(), sources, m), provider: 'Fixture provider', model: 'fixture-model', generatedAt: '', matrixRevision: m.revision } }
const actor = { id: 'user', name: 'BA', role: 'Contributor', modules: ['requirements'] }
function store(m = matrix()): RtmStore { return { rtms: [m], clients: [{ id: 'client', name: 'Client A', contact: '', email: '', status: 'Active', health: 'Good', notes: '' }], projects: [{ id: 'project', name: 'Rollout', status: 'Active', targetDate: '', summary: '' }], items: [], taskSettings: defaultTaskSettings } }

test('validates source kinds, IDs and size limits', () => {
  assert.equal(validateRtmSources(sources).length, 3)
  assert.throws(() => validateRtmSources([]), /Add 1/)
  assert.throws(() => validateRtmSources([...sources, sources[0]]), /unique/)
  assert.throws(() => validateRtmSources([{ ...sources[0], kind: 'instructions' }]), /Choose/)
  assert.throws(() => validateRtmSources([{ ...sources[0], text: 'a'.repeat(120001) }]), /Invalid/)
  assert.throws(() => validateRtmSources(sources.map(s => ({ ...s, text: 'a'.repeat(70000) }))), /180,000/)
})
test('requires real source IDs and verified quotation; invalid reference codes are removed', () => {
  const raw = output(); raw.candidates[0].evidence[0].sourceId = 'other-tenant'; assert.throws(() => validateRtmAiOutput(raw, sources, matrix()), /unknown source/)
  raw.candidates[0].evidence[0].sourceId = 'brd'; raw.candidates[0].evidence[0].excerpt = 'Fabricated specification.'; assert.throws(() => validateRtmAiOutput(raw, sources, matrix()), /could not be verified/)
  raw.candidates[0].evidence[0] = { ...output().candidates[0].evidence[0], reference: 'FAKE-REF' }
  const p = validateRtmAiOutput(raw, sources, matrix()); assert.equal(p.candidates[0].evidence[0].reference, ''); assert.match(p.candidates[0].warnings[0], /removed/)
})
test('rejects foreign existing requirements, duplicate keys and cycles', () => {
  const raw = output(); raw.candidates[0].existingRequirementId = 'foreign'; assert.throws(() => validateRtmAiOutput(raw, sources, matrix()), /outside this RTM/)
  raw.candidates[0].existingRequirementId = ''; raw.candidates[0].parentKey = 'R1'; assert.throws(() => validateRtmAiOutput(raw, sources, matrix()), /hierarchy/)
  raw.candidates[0].parentKey = ''; raw.candidates.push(structuredClone(raw.candidates[0])); assert.throws(() => validateRtmAiOutput(raw, sources, matrix()), /duplicate/)
})
test('test-case-only proposals are flagged and arbitrary AI action fields are discarded', () => {
  const raw: any = output(); raw.candidates[0].evidence = [raw.candidates[0].evidence[2]]; raw.candidates[0].assignee = 'admin'; raw.tasks = [{ title: 'Malicious task' }]; raw.candidates[0].status = 'Approved'
  const p = validateRtmAiOutput(raw, sources, matrix()); assert.match(p.candidates[0].warnings[0], /Inferred/); assert(!JSON.stringify(p).includes('Malicious')); assert(!('assignee' in p.candidates[0])); assert(!('status' in p.candidates[0]))
})
test('review and current matrix revision are mandatory; no input mutations', () => {
  const m = matrix(), p = preview(m), before = JSON.stringify(m)
  assert.throws(() => applyRtmAiSelection(m, p, ['R1'], false), /reviewed/)
  assert.throws(() => applyRtmAiSelection({ ...m, revision: 2 }, p, ['R1'], true), /changed/)
  assert.throws(() => applyRtmAiSelection(m, p, [], true), /Select/)
  const result = applyRtmAiSelection(m, p, ['R1'], true)
  assert.equal(JSON.stringify(m), before); assert.equal(result.requirements[0].code, 'REQ-001'); assert.equal(result.nextRequirementNumber, 2)
  assert.equal(result.requirements[0].phases.documentation.code, 'BR-01'); assert.equal(result.requirements[0].phases.fsd.code, '4.2 Password reset'); assert.equal(result.requirements[0].phases.testing.code, 'TC-01')
  assert(Object.values(result.requirements[0].phases).every(p => p.status === 'Not Started' && !p.override))
  assert.equal(result.requirements[0].sourceEvidence?.length, 3)
})
test('adding references preserves existing fields, work links and completion statuses', () => {
  const m = applyRtmAiSelection(matrix(), preview(), ['R1'], true), req = m.requirements[0]
  req.phases.testing.status = 'Passed'; req.phases.development.override = { status: 'Done', reason: 'Existing override' }
  const p = preview(m); p.candidates[0].existingRequirementId = req.id; p.candidates[0].title = 'Unapproved changed title'; p.candidates[0].priority = 'Urgent'
  const result = applyRtmAiSelection(m, p, ['R1'], true)
  assert.equal(result.requirements.length, 1); assert.deepEqual(result.requirements[0], req)
  assert(!('items' in result)); assert.equal(result.nextRequirementNumber, m.nextRequirementNumber)
})
test('duplicate new requirements blocked, including duplicate titles within batch', () => {
  const m = applyRtmAiSelection(matrix(), preview(), ['R1'], true)
  assert.throws(() => applyRtmAiSelection(m, preview(m), ['R1'], true), /already exists/)
  const p = preview(); p.candidates.push({ ...p.candidates[0], key: 'R2' }); assert.throws(() => applyRtmAiSelection(matrix(), p, ['R1', 'R2'], true), /already exists/)
})
test('selected children require selected parents; edited cycles fail before save', () => {
  const p = preview(); p.candidates.push({ ...p.candidates[0], key: 'R2', parentKey: 'R1', title: 'Expired link' })
  assert.throws(() => applyRtmAiSelection(matrix(), p, ['R2'], true), /parent requirement/)
  const next = applyRtmAiSelection(matrix(), p, ['R1', 'R2'], true); assert.equal(next.requirements[1].parentId, next.requirements[0].id)
  p.candidates[0].parentKey = 'R2'; assert.throws(() => applyRtmAiSelection(matrix(), p, ['R1', 'R2'], true), /cycle/)
})
test('source evidence persists through server reconciliation and cannot bypass validation', () => {
  const old = store(), mapped = applyRtmAiSelection(old.rtms![0], preview(), ['R1'], true)
  const next = { ...old, rtms: [reviseMatrix(old.rtms![0], mapped)] }; assertRtmMutation(old, next, actor)
  const saved = reconcileRtm(old, next, actor); assert.equal(saved.rtms![0].requirements[0].sourceEvidence?.length, 3); assert.match(saved.rtms![0].history[0].summary, /source evidence/)
  next.rtms[0].requirements[0].sourceEvidence![0].excerpt = 'x'.repeat(1501); assert.throws(() => assertRtmMutation(old, next, actor), /source evidence/)
})

async function fixture(options: { role?: string; modules?: string[]; enabled?: boolean; result?: string; fail?: boolean } = {}) {
  const app = express(); app.use(express.json())
  const calls: { tenant: string; agent: string }[] = [], inputs: string[] = [], loads: string[] = []
  const auth: express.RequestHandler = (req, res, next) => { if (req.headers['x-no-auth']) return void res.status(401).end(); (req as any).authUser = { ...actor, role: options.role || 'Contributor', modules: options.modules || ['requirements'], organizationId: 'tenant-A' }; next() }
  const aiAgents = { active: async (tenant: string, agent: string) => { calls.push({ tenant, agent }); return options.enabled === false ? null : { secret: 'never-return-this-secret', config: { provider: 'gemini', model: 'fixture-model' } } } } as any
  registerRtmAiRoutes(app, { requireAuth: auth, requireTenant: (_req, _res, next) => next(), aiAgents, load: async id => { loads.push(id); return { data: store() } }, runAi: async (_secret, _config, instruction, input) => { assert.match(instruction, /NOT instructions/); inputs.push(input); if (options.fail) throw new Error('never-return-this-secret'); return options.result ?? JSON.stringify(output()) } })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const body = { matrixId: 'rtm', matrixRevision: 1, sources, consent: true, provider: 'gemini', model: 'fixture-model', organizationId: 'tenant-B', tasks: ['do-not-use'] }
  return { calls, inputs, loads, body, get: () => fetch(base + '/api/requirements/ai/provider'), post: (changes: any = {}, headers: any = {}) => fetch(base + '/api/requirements/ai/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ ...body, ...changes }) }), close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
test('API uses authenticated tenant and Document Agent, returns safe config, and never writes tasks', async () => {
  const f = await fixture(); try {
    const config = await (await f.get()).json(); assert.equal(config.model, 'fixture-model'); assert(!JSON.stringify(config).includes('secret'))
    const res = await f.post(); assert.equal(res.status, 200); assert.equal((await res.json()).candidates.length, 1)
    assert(f.calls.every(c => c.tenant === 'tenant-A' && c.agent === 'document')); assert.deepEqual(f.loads, ['tenant-A']); assert(!f.inputs[0].includes('tenant-B')); assert(!f.inputs[0].includes('do-not-use'))
  } finally { await f.close() }
})
test('API rejects missing consent, foreign RTM, stale revision and changed provider before AI', async () => {
  const f = await fixture(); try { assert.equal((await f.post({ consent: false })).status, 400); assert.equal((await f.post({ matrixId: 'other-tenant-rtm' })).status, 404); assert.equal((await f.post({ matrixRevision: 2 })).status, 409); assert.equal((await f.post({ model: 'different' })).status, 409); assert.equal(f.inputs.length, 0) } finally { await f.close() }
})
test('API blocks viewer, disabled module and anonymous requests', async () => {
  for (const options of [{ role: 'Viewer' }, { modules: ['documents'] }]) { const f = await fixture(options); try { assert.equal((await f.post()).status, 403); assert.equal(f.calls.length, 0) } finally { await f.close() } }
  const f = await fixture(); try { assert.equal((await f.post({}, { 'x-no-auth': 'true' })).status, 401); assert.equal(f.calls.length, 0) } finally { await f.close() }
})
test('disabled agent, invalid AI JSON and provider failures do not expose credentials', async () => {
  for (const [options, status] of [[{ enabled: false }, 503], [{ result: '{broken' }, 422], [{ fail: true }, 502]] as const) {
    const f = await fixture(options); try { const res = await f.post(); assert.equal(res.status, status); assert(!(await res.text()).includes('never-return-this-secret')) } finally { await f.close() }
  }
})
