import type { Client, Project, WorkItem, TaskSettings, UserAccount, Priority } from '../../shared/types'
import { archivedWorkReason, isWorkDone, stableRecord, workContext, LifecycleError } from '../tasks/lifecycle'

export const RTM_STAGES = ['documentation', 'fsd', 'development', 'testing', 'presentation', 'approval'] as const
export type RtmStage = typeof RTM_STAGES[number]
export const STAGE_LABELS: Record<RtmStage, string> = { documentation: 'Documentation', fsd: 'FSD', development: 'Development', testing: 'Testing', presentation: 'Presentation / UAT', approval: 'Approval' }
export const RTM_STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Failed', 'Done', 'Passed', 'Approved', 'Not Applicable'] as const
export type RtmStatus = typeof RTM_STATUSES[number]
export type RtmLink = { matrixId: string; requirementId: string; stage: RtmStage; includeSubtasks: boolean }
export type RtmPhase = { status: RtmStatus; code: string; gap: string; documentUrl: string; section: string; override?: { status: RtmStatus; reason: string } }
export type RtmEvidence = { sourceId: string; name: string; kind: 'BRD' | 'FSD' | 'Test cases'; reference: string; excerpt: string }
export type Requirement = { id: string; code: string; parentId: string; title: string; description: string; environment: string; priority: Priority; revision: number; needsReview: boolean; phases: Record<RtmStage, RtmPhase>; sourceEvidence?: RtmEvidence[] }
export type RtmEvent = { id: string; at: string; actorId: string; actorName: string; requirementId?: string; stage?: RtmStage; summary: string; taskIds?: string[] }
export type RtmMatrix = { id: string; name: string; clientId: string; projectId: string; enhancement: string; contract: string; version: string; ownerId: string; environment: string; status: 'Draft' | 'Active' | 'Completed' | 'Archived'; revision: number; nextRequirementNumber: number; createdAt: string; updatedAt: string; requirements: Requirement[]; history: RtmEvent[] }
export type RtmStore = { clients: Client[]; projects: Project[]; items: WorkItem[]; taskSettings: TaskSettings; accounts?: UserAccount[]; rtms?: RtmMatrix[] }
export type RtmActor = { id?: string; name?: string; role: string; modules: string[]; accountType?: string }
export type StageResult = { status: RtmStatus; automatic: RtmStatus; linked: WorkItem[]; units: WorkItem[]; done: number; total: number; overridden: boolean }
export const newPhases = (): Record<RtmStage, RtmPhase> => Object.fromEntries(RTM_STAGES.map(stage => [stage, { status: 'Not Started', code: '', gap: '', documentUrl: '', section: '' }])) as Record<RtmStage, RtmPhase>
export const phaseComplete = (status: RtmStatus) => ['Done', 'Passed', 'Approved'].includes(status)
export const phaseSatisfied = (status: RtmStatus) => phaseComplete(status) || status === 'Not Applicable'
export function taskRtmStatus(item: WorkItem, stage: RtmStage, settings: TaskSettings): RtmStatus {
  const value = item.status.trim().toLowerCase()
  if (stage === 'testing' && item.qaResult === 'Failed' || /fail|reject/.test(value)) return 'Failed'
  if (stage === 'testing' && item.qaResult === 'Blocked' || /block|cancel/.test(value)) return 'Blocked'
  if (isWorkDone(item, settings) || ['done', 'completed', 'passed', 'approved'].includes(value)) {
    if (stage === 'testing' && (item.qaResult === 'Passed' || value === 'passed')) return 'Passed'
    return stage === 'approval' ? 'Approved' : 'Done'
  }
  return ['open', 'pending', 'not started', 'to do', 'todo', 'backlog'].includes(value) ? 'Not Started' : 'In Progress'
}
export function stageResult(state: RtmStore, matrix: RtmMatrix, req: Requirement, stage: RtmStage): StageResult {
  const sameContext = (item: WorkItem) => { const ctx = workContext(state, item); return ctx.clientId === matrix.clientId && ctx.projectId === matrix.projectId }
  const linked = state.items.filter(item => sameContext(item) && item.rtmLinks?.some(link => link.matrixId === matrix.id && link.requirementId === req.id && link.stage === stage))
  const unitsMap = new Map<string, WorkItem>()
  for (const task of linked) {
    const link = task.rtmLinks!.find(l => l.matrixId === matrix.id && l.requirementId === req.id && l.stage === stage)!
    const children = link.includeSubtasks ? state.items.filter(item => item.parentTaskId === task.id && sameContext(item)) : []
    for (const unit of children.length ? children : [task]) unitsMap.set(unit.id, unit)
  }
  const units = [...unitsMap.values()], statuses = units.map(item => taskRtmStatus(item, stage, state.taskSettings))
  const directStatuses = linked.map(item => taskRtmStatus(item, stage, state.taskSettings))
  const done = statuses.filter(phaseComplete).length
  let automatic: RtmStatus = req.phases[stage].status
  if (linked.length) {
    if ([...statuses, ...directStatuses].includes('Failed')) automatic = 'Failed'
    else if ([...statuses, ...directStatuses].includes('Blocked')) automatic = 'Blocked'
    else if (done === units.length && units.length) automatic = stage === 'testing' && statuses.every(s => s === 'Passed') ? 'Passed' : stage === 'approval' ? 'Approved' : 'Done'
    else automatic = done || [...statuses, ...directStatuses].some(s => s !== 'Not Started') ? 'In Progress' : 'Not Started'
  }
  const override = req.phases[stage].override
  return { status: override?.status || automatic, automatic, linked, units, done, total: units.length, overridden: Boolean(override) }
}
export function requirementAttention(state: RtmStore, matrix: RtmMatrix, req: Requirement): string[] {
  const messages: string[] = []
  if (req.needsReview) messages.push('Requirement changed — review linked work and approvals')
  for (const stage of RTM_STAGES) {
    const result = stageResult(state, matrix, req, stage), phase = req.phases[stage]
    if (['Failed', 'Blocked'].includes(result.status)) messages.push(`${STAGE_LABELS[stage]} ${result.status.toLowerCase()}`)
    if (['fsd', 'testing'].includes(stage) && result.status !== 'Not Applicable' && !result.linked.length && !phase.code && !phase.documentUrl) messages.push(`No ${STAGE_LABELS[stage]} reference or linked work`)
    if (result.overridden && !phaseSatisfied(result.automatic)) messages.push(`${STAGE_LABELS[stage]} manually overridden`)
  }
  if (phaseComplete(stageResult(state, matrix, req, 'development').status) && !phaseSatisfied(stageResult(state, matrix, req, 'testing').status)) messages.push('Developed but not tested')
  return messages
}
export function matrixCoverage(state: RtmStore, matrix: RtmMatrix) {
  return RTM_STAGES.map(stage => {
    const statuses = matrix.requirements.map(req => stageResult(state, matrix, req, stage).status)
    const total = statuses.filter(s => s !== 'Not Applicable').length, done = statuses.filter(phaseComplete).length
    return { stage, total, done, percent: total ? Math.round(done / total * 100) : 0, excluded: statuses.length - total }
  })
}
export function orderedRequirements(requirements: Requirement[]): { requirement: Requirement; depth: number }[] {
  const output: { requirement: Requirement; depth: number }[] = [], visited = new Set<string>()
  const walk = (parentId: string, depth: number) => { for (const requirement of requirements.filter(r => r.parentId === parentId)) { if (visited.has(requirement.id)) continue; visited.add(requirement.id); output.push({ requirement, depth }); walk(requirement.id, depth + 1) } }
  walk('', 0)
  return output
}
const content = (req: Requirement) => ({ title: req.title, description: req.description, environment: req.environment, priority: req.priority, parentId: req.parentId, sourceEvidence: req.sourceEvidence })
const matrixEditable = (matrix: RtmMatrix) => ({ ...matrix, revision: undefined, history: undefined, createdAt: undefined, updatedAt: undefined, requirements: matrix.requirements.map(req => ({ ...req, revision: undefined })) })
function assert(value: unknown, message: string, status = 400): asserts value { if (!value) throw new LifecycleError(message, status) }
const textField = (value: unknown, max: number) => typeof value === 'string' && value.length <= max

/** All persisted RTM relationships are checked in the tenant snapshot before commit. */
export function assertRtmMutation(current: RtmStore, next: RtmStore, actor: RtmActor | null) {
  assert(Array.isArray(next.rtms ?? []), 'RTMs must be an array.')
  const matrices = next.rtms || [], oldMatrices = current.rtms || []
  assert(matrices.length <= 500, 'A workspace can contain up to 500 RTMs.')
  const ids = new Set<string>()
  for (const matrix of matrices) {
    assert(matrix && textField(matrix.id, 100) && matrix.id && !ids.has(matrix.id), 'Invalid or duplicate RTM ID.'); ids.add(matrix.id)
    assert(Array.isArray(matrix.requirements) && matrix.requirements.length <= 2000, 'An RTM supports up to 2,000 requirements.')
    assert(textField(matrix.name, 200) && matrix.name.trim(), 'RTM name is required (up to 200 characters).')
    for (const field of ['enhancement', 'contract', 'version', 'environment', 'ownerId'] as const) assert(textField(matrix[field], 500), 'Invalid RTM header field.')
    assert(next.clients.some(c => c.id === matrix.clientId) && next.projects.some(p => p.id === matrix.projectId), 'Select an existing client and project for the RTM.')
    assert(!matrix.ownerId || next.accounts?.some(a => a.id === matrix.ownerId), 'Choose an owner in this workspace.')
    assert(['Draft', 'Active', 'Completed', 'Archived'].includes(matrix.status), 'Invalid RTM status.')
    assert(Number.isSafeInteger(matrix.nextRequirementNumber) && matrix.nextRequirementNumber > 0, 'Invalid requirement counter.')
    const old = oldMatrices.find(m => m.id === matrix.id)
    const changed = !old || stableRecord(matrixEditable(old)) !== stableRecord(matrixEditable(matrix))
    assert(Number.isSafeInteger(matrix.revision) && matrix.revision === (old?.revision || 0) + (changed ? 1 : 0), 'This RTM changed in another session. Reload before saving.', 409)
    if (old) assert(old.clientId === matrix.clientId && old.projectId === matrix.projectId, 'RTM client and project cannot be changed. Create a separate RTM.')
    if (changed) {
      if (actor) assert(actor.accountType !== 'platform' && actor.role !== 'Viewer' && actor.modules.includes('requirements'), 'Requirements & Traceability edit access is required.', 403)
      assert(!archivedWorkReason(next, matrix), archivedWorkReason(next, matrix), 409)
      if (old?.status === 'Archived') assert(matrix.status !== 'Archived' && stableRecord({ ...matrixEditable(old), status: matrix.status }) === stableRecord(matrixEditable(matrix)), 'Activate this RTM before editing its contents.', 409)
    }
    const reqIds = new Set<string>(), codes = new Set<string>()
    for (const req of matrix.requirements) {
      assert(req && textField(req.id, 100) && req.id && !reqIds.has(req.id), 'Invalid or duplicate requirement ID.'); reqIds.add(req.id)
      assert(textField(req.code, 80) && req.code.trim() && !codes.has(req.code.toLowerCase()), 'Requirement codes must be unique within an RTM.'); codes.add(req.code.toLowerCase())
      assert(textField(req.title, 500) && req.title.trim() && textField(req.description, 20000) && textField(req.environment, 500), 'Requirement title is required; check field lengths.')
      assert(['Low', 'Medium', 'High', 'Urgent'].includes(req.priority) && typeof req.needsReview === 'boolean', 'Invalid requirement priority or review state.')
      if (req.sourceEvidence !== undefined) {
        assert(Array.isArray(req.sourceEvidence) && req.sourceEvidence.length <= 100, 'A requirement supports up to 100 source references.')
        for (const source of req.sourceEvidence) assert(source && ['BRD', 'FSD', 'Test cases'].includes(source.kind) && textField(source.sourceId, 100) && textField(source.name, 200) && source.name.trim() && textField(source.reference, 250) && textField(source.excerpt, 1500) && source.excerpt.trim(), 'Invalid requirement source evidence.')
      }
      const prior = old?.requirements.find(r => r.id === req.id)
      if (prior) assert(prior.code === req.code, 'A permanent requirement code cannot be changed.')
      const seen = new Set([req.id]); let parent = req.parentId
      while (parent) { assert(!seen.has(parent), 'Requirements cannot contain a parent cycle.'); seen.add(parent); const row = matrix.requirements.find(r => r.id === parent); assert(row, 'Parent requirement must belong to this RTM.'); parent = row.parentId }
      assert(req.phases && typeof req.phases === 'object', 'Requirement stages are required.')
      for (const stage of RTM_STAGES) {
        const phase = req.phases[stage]
        assert(phase && RTM_STATUSES.includes(phase.status), 'Invalid RTM stage status.')
        for (const field of ['code', 'gap', 'documentUrl', 'section'] as const) assert(textField(phase[field], 2000), 'Invalid stage reference.')
        if (phase.documentUrl) { let url: URL; try { url = new URL(phase.documentUrl) } catch { throw new LifecycleError('Document links must be full HTTP or HTTPS URLs.', 400) }; assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, 'Use an HTTP or HTTPS document link without credentials.') }
        if (phase.override) assert(RTM_STATUSES.includes(phase.override.status) && textField(phase.override.reason, 2000) && phase.override.reason.trim(), 'A manual override requires a status and reason.')
        if (stableRecord(prior?.phases[stage].override) !== stableRecord(phase.override) && actor) assert(actor.role === 'Administrator' && actor.modules.includes('requirements'), 'Only an Administrator with RTM access can override automatic status.', 403)
      }
    }
  }
  for (const old of oldMatrices) assert(ids.has(old.id), 'Archive RTMs instead of deleting them.', 409)
  for (const item of next.items) {
    const links = item.rtmLinks || [], oldItem = current.items.find(t => t.id === item.id)
    assert(Array.isArray(links) && links.length <= 50, 'A task can link to up to 50 RTM stages.')
    assert(!item.qaResult || ['Not Run', 'Passed', 'Failed', 'Blocked'].includes(item.qaResult), 'Invalid QA result.')
    if (stableRecord(links) !== stableRecord(oldItem?.rtmLinks || []) && actor) assert(actor.role !== 'Viewer' && actor.modules.includes('requirements') && actor.modules.includes('items'), 'Task and Requirements access are required to change RTM links.', 403)
    const seen = new Set<string>()
    for (const link of links) {
      assert(link && RTM_STAGES.includes(link.stage) && typeof link.includeSubtasks === 'boolean', 'Invalid RTM task link.')
      const key = `${link.matrixId}:${link.requirementId}:${link.stage}`; assert(!seen.has(key), 'Duplicate RTM task link.'); seen.add(key)
      const matrix = matrices.find(m => m.id === link.matrixId)
      assert(matrix && matrix.requirements.some(r => r.id === link.requirementId), 'Unlink work before removing a requirement.')
      const ctx = workContext(next, item)
      assert(ctx.clientId === matrix.clientId && ctx.projectId === matrix.projectId, 'Linked work must match the RTM client and project. Unlink it before moving the task.')
      if (!oldItem?.rtmLinks?.some(l => stableRecord(l) === stableRecord(link))) assert(matrix.status !== 'Archived', 'Activate the RTM before adding work links.', 409)
    }
  }
}

/** Server uses authenticated actor; client history and timestamps are ignored. */
export function reconcileRtm<T extends RtmStore>(current: RtmStore, next: T, actor: RtmActor | null, at = new Date().toISOString()): T {
  const rtms = (next.rtms || []).map(matrix => {
    const old = current.rtms?.find(m => m.id === matrix.id), events: RtmEvent[] = []
    const event = (summary: string, requirementId?: string, stage?: RtmStage, taskIds?: string[]) => events.push({ id: crypto.randomUUID(), at, actorId: actor?.id || 'system', actorName: actor?.name || 'System', summary, requirementId, stage, taskIds })
    if (!old) event(`Created RTM “${matrix.name}”`)
    else if (stableRecord({ ...matrixEditable(old), requirements: undefined }) !== stableRecord({ ...matrixEditable(matrix), requirements: undefined })) event('Updated RTM header or lifecycle status')
    const requirements = matrix.requirements.map(req => {
      const prior = old?.requirements.find(r => r.id === req.id), changed = prior && stableRecord(content(prior)) !== stableRecord(content(req))
      const result = { ...req, revision: prior ? prior.revision + (changed ? 1 : 0) : 1, needsReview: Boolean(changed || req.needsReview) }
      if (!prior) event(`Added ${req.code}: ${req.title}${req.sourceEvidence?.length ? ' (document mapping with source evidence)' : ''}`, req.id)
      else if (changed) event(`${req.code} changed (revision ${result.revision}); review FSD, development, testing, UAT and approval links`, req.id)
      else if (prior.needsReview && !req.needsReview) event(`${req.code}: impact review completed`, req.id)
      for (const stage of RTM_STAGES) {
        if (prior && stableRecord(prior.phases[stage]) !== stableRecord(req.phases[stage])) event(`${req.code} · ${STAGE_LABELS[stage]}: ${req.phases[stage].override ? `manual override — ${req.phases[stage].override!.status}; ${req.phases[stage].override!.reason}` : prior.phases[stage].override ? 'automatic calculation restored' : 'updated status or references'}`, req.id, stage)
        const after = stageResult(next, matrix, result, stage), before = prior && old ? stageResult(current, old, prior, stage) : null
        const beforeLinks = before?.linked.map(t => ({ id: t.id, links: t.rtmLinks?.filter(l => l.matrixId === matrix.id && l.requirementId === req.id && l.stage === stage) })) || []
        const afterLinks = after.linked.map(t => ({ id: t.id, links: t.rtmLinks?.filter(l => l.matrixId === matrix.id && l.requirementId === req.id && l.stage === stage) }))
        if (stableRecord(beforeLinks) !== stableRecord(afterLinks)) event(`${req.code} · ${STAGE_LABELS[stage]}: linked work updated (${after.linked.length} direct links)`, req.id, stage, [...new Set([...beforeLinks, ...afterLinks].map(t => t.id))])
        if (before && (before.status !== after.status || before.done !== after.done || before.total !== after.total || before.automatic !== after.automatic)) event(`${req.code} · ${STAGE_LABELS[stage]}: ${before.status} → ${after.status} (${after.done}/${after.total} work units complete; automatic: ${after.automatic})`, req.id, stage, after.units.map(t => t.id))
      }
      return result
    })
    for (const prior of old?.requirements || []) if (!requirements.some(r => r.id === prior.id)) event(`Removed requirement ${prior.code}: ${prior.title}`, prior.id)
    return { ...matrix, requirements, createdAt: old?.createdAt || at, updatedAt: events.length ? at : old?.updatedAt || at, history: [...events.reverse(), ...(old?.history || [])].slice(0, 10000) }
  })
  return { ...next, rtms }
}
export function reviseMatrix(previous: RtmMatrix, next: RtmMatrix): RtmMatrix {
  return { ...next, revision: previous.revision + (stableRecord(matrixEditable(previous)) !== stableRecord(matrixEditable(next)) ? 1 : 0) }
}
