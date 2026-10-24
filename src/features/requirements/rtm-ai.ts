import { newPhases, type Requirement, type RtmMatrix, type RtmEvidence } from './rtm'

export const RTM_SOURCE_KINDS = ['BRD', 'FSD', 'Test cases'] as const
export type RtmSourceKind = typeof RTM_SOURCE_KINDS[number]
export type RtmAiSource = { id: string; name: string; kind: RtmSourceKind; text: string }
export type RtmAiCandidate = {
  key: string; parentKey: string; title: string; description: string; priority: Requirement['priority']
  existingRequirementId: string; matchReason: string; warnings: string[]; evidence: RtmEvidence[]
}
export type RtmAiPreview = { candidates: RtmAiCandidate[]; gaps: string[]; conflicts: string[]; provider: string; model: string; generatedAt: string; matrixRevision: number }
export const RTM_AI_LIMITS = { sources: 12, sourceChars: 120000, totalChars: 180000, candidates: 80 }
const normalized = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
function text(v: unknown, label: string, max: number, required = false): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) || required && !v.trim()) throw new Error(`Invalid ${label} (maximum ${max} characters).`)
  return v.trim()
}
export function validateRtmSources(value: unknown): RtmAiSource[] {
  if (!Array.isArray(value) || !value.length || value.length > RTM_AI_LIMITS.sources) throw new Error('Add 1 to 12 BRD, FSD or test-case sources.')
  const sources = value.map(s => {
    if (!RTM_SOURCE_KINDS.includes(s?.kind)) throw new Error('Choose BRD, FSD or Test cases for every source.')
    return { id: text(s.id, 'source ID', 100, true), name: text(s.name, 'source name', 200, true), kind: s.kind as RtmSourceKind, text: text(s.text, 'source text', RTM_AI_LIMITS.sourceChars, true) }
  })
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Source IDs must be unique.')
  if (sources.reduce((n, s) => n + s.text.length, 0) > RTM_AI_LIMITS.totalChars) throw new Error('Sources exceed 180,000 characters. Import a smaller batch.')
  return sources
}
const notices = (v: unknown, label: string, max = 100): string[] => {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Invalid ${label} list.`)
  return v.map(s => text(s, label, 1000, true))
}
/** AI output is untrusted: retain only the mapping schema and verify quoted evidence. */
export function validateRtmAiOutput(value: any, sources: RtmAiSource[], matrix: RtmMatrix): Pick<RtmAiPreview, 'candidates' | 'gaps' | 'conflicts'> {
  if (!Array.isArray(value?.candidates) || value.candidates.length > RTM_AI_LIMITS.candidates) throw new Error('The AI returned too many rows or an invalid mapping. Use a smaller scope.')
  const candidates: RtmAiCandidate[] = value.candidates.map((row: any) => {
    const warnings = notices(row?.warnings ?? [], 'row warnings', 12)
    if (!Array.isArray(row?.evidence) || !row.evidence.length || row.evidence.length > 20) throw new Error('Every proposed requirement needs 1–20 source references.')
    const evidence: RtmEvidence[] = row.evidence.map((entry: any) => {
      const source = sources.find(s => s.id === entry?.sourceId)
      if (!source) throw new Error('The AI cited an unknown source. Regenerate the mapping.')
      const excerpt = text(entry.excerpt, 'source excerpt', 1500, true)
      if (normalized(excerpt).length < 8 || !normalized(source.text).includes(normalized(excerpt))) throw new Error('An AI quote could not be verified against its source. Regenerate or narrow the source text.')
      let reference = text(entry.reference ?? '', 'source reference', 250)
      if (reference && !normalized(source.text).includes(normalized(reference))) {
        warnings.push(`Check the reference in ${source.name}; an unverified AI section/code was removed.`)
        reference = ''
      }
      return { sourceId: source.id, name: source.name, kind: source.kind, reference, excerpt }
    })
    const existingRequirementId = text(row.existingRequirementId ?? '', 'existing requirement ID', 100)
    if (existingRequirementId && !matrix.requirements.some(r => r.id === existingRequirementId)) throw new Error('The AI suggested a requirement outside this RTM. Regenerate the mapping.')
    if (evidence.every(e => e.kind === 'Test cases')) warnings.push('Inferred from test cases only. Confirm this is an agreed requirement before adding it.')
    const priority = ['Low', 'Medium', 'High', 'Urgent'].includes(row.priority) ? row.priority : 'Medium'
    return { key: text(row.key, 'candidate key', 80, true), parentKey: text(row.parentKey ?? '', 'parent key', 80), title: text(row.title, 'requirement title', 500, true), description: text(row.description, 'requirement details', 12000), priority, existingRequirementId, matchReason: text(row.matchReason ?? '', 'mapping explanation', 1000), warnings: [...new Set(warnings)], evidence }
  })
  const byKey = new Map(candidates.map(r => [r.key, r]))
  if (byKey.size !== candidates.length) throw new Error('The AI returned duplicate row keys.')
  for (const row of candidates) {
    const seen = new Set([row.key]); let key = row.parentKey
    while (key) { if (seen.has(key) || !byKey.has(key)) throw new Error('The AI returned an invalid requirement hierarchy.'); seen.add(key); key = byKey.get(key)!.parentKey }
  }
  return { candidates, gaps: notices(value.gaps ?? [], 'gaps'), conflicts: notices(value.conflicts ?? [], 'conflicts') }
}
export function matchingRequirements(matrix: RtmMatrix, row: RtmAiCandidate) {
  return matrix.requirements.filter(r => normalized(r.title) === normalized(row.title) || row.evidence.some(e => e.reference && Object.values(r.phases).some(p => p.code.split(';').some(c => normalized(c) === normalized(e.reference)))))
}
function uniqueEvidence(values: RtmEvidence[]) {
  const result = [...new Map(values.map(e => [JSON.stringify([e.kind, e.name, e.reference, e.excerpt]), e])).values()]
  if (result.length > 100) throw new Error('This requirement would exceed 100 source references. Use a separate requirement.')
  return result
}
/** No tasks are inputs or outputs. Existing rows receive references only, never new statuses. */
export function applyRtmAiSelection(matrix: RtmMatrix, preview: RtmAiPreview, selected: string[], reviewed: boolean): RtmMatrix {
  if (!reviewed) throw new Error('Confirm that you reviewed the mapping first.')
  if (matrix.status === 'Archived') throw new Error('Activate this RTM before importing.')
  if (matrix.revision !== preview.matrixRevision) throw new Error('This RTM changed after the preview. Generate a fresh mapping before saving.')
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('Select at least one unique preview row.')
  const rows = selected.map(key => { const row = preview.candidates.find(r => r.key === key); if (!row) throw new Error('Unknown preview row.'); return row })
  const result = structuredClone(matrix), ids = new Map<string, string>(), targets = new Set<string>()
  for (const row of rows) {
    if (row.existingRequirementId) {
      if (!result.requirements.some(r => r.id === row.existingRequirementId)) throw new Error('The selected existing requirement is no longer available.')
      if (targets.has(row.existingRequirementId)) throw new Error('Two selected rows target the same requirement. Combine their sources or import them in separate reviewed batches.')
      targets.add(row.existingRequirementId); ids.set(row.key, row.existingRequirementId)
    } else {
      if (result.requirements.some(r => normalized(r.title) === normalized(row.title))) throw new Error(`“${row.title}” already exists. Choose Add references to that requirement or skip the row.`)
      ids.set(row.key, crypto.randomUUID())
      const codeSet = new Set(result.requirements.map(r => r.code.toLowerCase()))
      let code: string
      do { code = `REQ-${String(result.nextRequirementNumber++).padStart(3, '0')}` } while (codeSet.has(code.toLowerCase()))
      result.requirements.push({ id: ids.get(row.key)!, code, parentId: '', title: text(row.title, 'title', 500, true), description: text(row.description, 'details', 12000), priority: row.priority, environment: matrix.environment, revision: 1, needsReview: false, phases: newPhases() })
    }
  }
  if (result.requirements.length > 2000) throw new Error('This import would exceed 2,000 requirements in the RTM.')
  for (const row of rows) {
    const req = result.requirements.find(r => r.id === ids.get(row.key))!
    if (!row.existingRequirementId && row.parentKey) {
      const parent = ids.get(row.parentKey)
      if (!parent) throw new Error('Select the parent requirement too, or change the row to Top level.')
      req.parentId = parent
    }
    req.sourceEvidence = uniqueEvidence([...(req.sourceEvidence || []), ...row.evidence])
    for (const [kind, stage] of [['BRD', 'documentation'], ['FSD', 'fsd'], ['Test cases', 'testing']] as const) {
      const refs = row.evidence.filter(e => e.kind === kind)
      if (!refs.length) continue
      const phase = req.phases[stage]
      const join = (current: string, values: string[]) => [...new Set([...current.split(';').map(v => v.trim()), ...values].filter(Boolean))].join('; ')
      const code = join(phase.code, refs.map(e => e.reference || e.name))
      const section = join(phase.section, refs.map(e => e.name + (e.reference ? ` — ${e.reference}` : '')))
      if (code.length > 2000 || section.length > 2000) throw new Error('Too many stage references for one requirement. Import fewer references.')
      phase.code = code; phase.section = section
    }
  }
  for (const req of result.requirements) {
    const seen = new Set([req.id]); let parent = req.parentId
    while (parent) {
      if (seen.has(parent)) throw new Error('Parent choices create a hierarchy cycle. Choose a different parent.')
      seen.add(parent); const row = result.requirements.find(r => r.id === parent)
      if (!row) throw new Error('A parent requirement is missing.')
      parent = row.parentId
    }
  }
  return result
}
