export type BrdSourceKind = 'Requirements' | 'Meeting notes' | 'Supporting document' | 'Chat'
export type BrdSource = { id: string; name: string; kind: BrdSourceKind; text: string }
export type BrdDetails = {
  projectName: string
  module: string
  date: string
  preparedBy: string
  version: string
  reference: string
}
export type BrdStakeholder = { stakeholder: string; responsibility: string; sourceIds: string[]; inferred?: boolean }
export type BrdRequirement = {
  id: string
  requirement: string
  description: string
  acceptanceCriteria: string[]
  sourceIds: string[]
  inferred?: boolean
}
export type BrdMappingRow = {
  source: string
  sourceField: string
  target: string
  targetField: string
  rule: string
  sourceIds: string[]
  inferred?: boolean
}
export type BrdPreview = {
  summary: string
  businessObjectives: string[]
  businessProblems: string[]
  inScope: string[]
  stakeholders: BrdStakeholder[]
  functionalRequirements: BrdRequirement[]
  customerMapping: BrdMappingRow[]
  openQuestions: string[]
  provider: string
  model: string
  generatedAt: string
}
export type BrdDraft = {
  details: BrdDetails
  fileNameOverride?: string
  sources: BrdSource[]
  pasteName: string
  pasteText: string
  pasteKind: BrdSourceKind
  guidance: string
  preview: BrdPreview | null
  revision: number
  previewRevision: number
  reviewed: boolean
}
export const BRD_TEMPLATE_NAME = 'iRipple Business Requirement Document'
export function emptyBrdDraft(): BrdDraft {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  return {
    details: { projectName: '', module: '', date, preparedBy: '', version: '1.0', reference: '' },
    sources: [], pasteName: '', pasteText: '', pasteKind: 'Requirements', guidance: '',
    preview: null, revision: 0, previewRevision: -1, reviewed: false,
  }
}
export function brdReference(details: BrdDetails) {
  if (details.reference.trim()) return details.reference.trim()
  const project = details.projectName.replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,18) || 'PROJECT'
  const compactDate = details.date.replace(/-/g,'') || new Date().toISOString().slice(0,10).replace(/-/g,'')
  return `BRD-${project}-${compactDate}-01`
}
export function brdHandoffText(details: BrdDetails, preview: BrdPreview) {
  return JSON.stringify({
    documentType: 'Business Requirements Document',
    reference: brdReference(details),
    projectName: details.projectName || 'TBD Project',
    module: details.module || 'TBD Module',
    date: details.date,
    preparedBy: details.preparedBy || 'TBD',
    version: details.version || '1.0',
    summary: preview.summary,
    businessObjectives: preview.businessObjectives,
    businessProblems: preview.businessProblems,
    inScope: preview.inScope,
    stakeholders: preview.stakeholders,
    functionalRequirements: preview.functionalRequirements,
    customerMapping: preview.customerMapping,
    openQuestions: preview.openQuestions,
  }, null, 2)
}
