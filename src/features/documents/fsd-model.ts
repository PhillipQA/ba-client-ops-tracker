export type FsdMode = 'advanced'
export const FSD_TEMPLATE_NAME = 'FSD Template 052026 - NEW'
export const FSD_MODULES = ['MMS Feature', 'MMS Report', 'Lynexus Feature', 'POS Feature'] as const
export type FsdLegacyModule = (typeof FSD_MODULES)[number]
export type FsdFeatureId = `feature-${string}`
export type FsdFeature = { id: FsdFeatureId; name: string }
export type FsdModule = FsdLegacyModule | FsdFeatureId
export const FSD_MODULE_SECTION: Record<FsdLegacyModule, 'mms' | 'report' | 'lynexus' | 'pos'> = {
  'MMS Feature': 'mms',
  'MMS Report': 'report',
  'Lynexus Feature': 'lynexus',
  'POS Feature': 'pos',
}
export const FSD_MODULE_SECTION_IDS = Object.values(FSD_MODULE_SECTION)
export function isCustomFsdFeature(id: string): id is FsdFeatureId {
  return /^feature-[a-zA-Z0-9_-]{1,64}$/.test(id)
}
export function fsdModuleSection(module: FsdModule) {
  return isCustomFsdFeature(module) ? module : FSD_MODULE_SECTION[module as FsdLegacyModule]
}
export function isFsdFeatureSection(id: string) {
  return isCustomFsdFeature(id) || FSD_MODULE_SECTION_IDS.includes(id as (typeof FSD_MODULE_SECTION_IDS)[number])
}
export type FsdBlock = (
  | { type: 'paragraph'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
) & { requirementIds?: string[] }
export type FsdSection = { id: string; title: string; blocks: FsdBlock[]; sourceIds: string[] }
export type FsdRequirement = {
  id: string
  requirement: string
  module: FsdModule | 'General'
  evidence: { sourceId: string; quote: string }[]
}
export type FsdSourceAnalysis = {
  fingerprint: string
  readability: 'readable' | 'partial' | 'unreadable'
  summary: string
  requirements: FsdRequirement[]
  gaps: string[]
  complete: boolean
  provider: string
  model: string
  analyzedAt: string
}
export type FsdUploadFailure = { id: string; name: string; reason: string }
export type FsdGenerationMode = 'standard' | 'available'
export type FsdSourceCoverage = {
  contributingSourceIds?: string[]
  noRelevantSourceIds?: string[]
  excludedSources?: { id: string; name: string; reason: string }[]
  usedSourceIds: string[]
  partialSourceIds: string[]
  skippedSources: { id: string; name: string; reason: string }[]
}
export type FsdPreview = {
  uploadFailures?: FsdUploadFailure[]
  sections: FsdSection[]
  gaps: string[]
  conflicts: string[]
  provider: string
  model: string
  generatedAt: string
  interpretationGaps?: string[]
  requirements?: FsdRequirement[]
  generationMode?: FsdGenerationMode
  sourceCoverage?: FsdSourceCoverage
  features?: FsdFeature[]
}
export type FsdSource = {
  id: string
  name: string
  kind: 'BRD' | 'Meeting notes' | 'Supporting document' | 'Chat'
  text: string
  target: string
  analysis?: FsdSourceAnalysis
  analysisError?: string
}
export type FsdPreset = { id: string; name: string; instructions: string }
export const FSD_PRESETS: FsdPreset[] = [
  {
    id: 'standard',
    name: 'Standard Business Analyst',
    instructions:
      'Use clear, formal business language. Translate supported business needs into implementable requirements and measurable acceptance criteria. Cover normal, alternate, error and cancellation paths.',
  },
  {
    id: 'qa',
    name: 'QA & UAT Ready',
    instructions:
      'Emphasize testable acceptance criteria, boundary conditions, roles and permissions, invalid inputs, error messages, and recovery. Label proposed test cases and unknown expected results for confirmation.',
  },
  {
    id: 'integration',
    name: 'API & Integration',
    instructions:
      'Emphasize interfaces, input/output mappings, validation, timeouts, retries, idempotency and errors where supported by sources. Mark unprovided endpoints, data types and error codes as TBD; do not invent them.',
  },
  {
    id: 'retail',
    name: 'Retail / POS',
    instructions:
      'Emphasize applicable POS, MMS, reports and Lynexus behavior; online/offline variations, tender/discount rules, permissions and reconciliation only when relevant to the supplied requirements.',
  },
]
export const FSD_SECTIONS = [
  ['summary', '1.1 Executive Summary'],
  ['scope', '1.2 Scope Definition'],
  ['audience', '1.3 Document Audience'],
  ['history', '2. Document History'],
  ['business', '3. Business Requirements'],
  ['functional', '4. Functional Requirements'],
  ['acceptance', '4.1 Acceptance Criteria'],
  ['mms', '5.1 MMS Feature'],
  ['report', '5.2 MMS Report'],
  ['lynexus', '5.3 Lynexus Feature'],
  ['pos', '5.4 POS Feature'],
  ['assumptions', '6.1 Assumptions'],
  ['limitations', '6.2 Limitations and Constraints'],
  ['acknowledgement', 'VII. Acknowledgement'],
  ['references', 'VIII. References'],
] as const
export type FsdSectionId = (typeof FSD_SECTIONS)[number][0] | FsdFeatureId
export function fsdSectionsForModules(
  modules: readonly FsdModule[],
  features?: readonly FsdFeature[],
): (readonly [FsdSectionId, string])[] {
  if (features) {
    const sections: (readonly [FsdSectionId, string])[] = []
    for (const [id, title] of FSD_SECTIONS) {
      if (isFsdFeatureSection(id)) continue
      sections.push([id, title])
      if (id === 'acceptance')
        sections.push(
          ...features.map(
            (feature, i) =>
              [feature.id, `5.${i + 1} ${feature.name.trim() || `Feature ${i + 1} (name pending)`}`] as const,
          ),
        )
    }
    return sections
  }
  const selected = new Set<string>(modules.map(fsdModuleSection))
  return FSD_SECTIONS.filter(([id]) => !isFsdFeatureSection(id) || selected.has(id))
}
export function fsdExcludedModules(modules: readonly FsdModule[]) {
  if (modules.some(isCustomFsdFeature)) return []
  const selected = new Set(modules)
  return FSD_MODULES.filter(module => !selected.has(module))
}
export const FSD_NOTICE = `The information contained in this document is proprietary to IRipple, Inc. The information in this document shall not be reproduced, shown or disclosed outside the IRipple, Inc. without written permission. Information contained in this document is highly sensitive and of a competitive nature.

NO WARRANTIES OF ANY NATURE ARE EXTENDED BY THIS DOCUMENT. Any product and related material disclosed herein are only furnished pursuant and subject to the terms and conditions of a duly executed license or agreement to purchase services or equipment. The only warranties made by IRipple, Inc. if any, with respect to the products, programs or services described in this document are set forth in such license or agreement. IRipple, Inc. cannot accept any financial or other responsibility that may be the result of your use of the information in this document, including but not limited to direct, indirect, special or consequential damages.

You should be very careful to ensure the use of this information and/or software material complies with the laws, rules, and regulations of the jurisdictions with respect to which it is used. The information contained herein is subject to change without notice. Revisions may be issued to advise of such changes and/or additions.`
export type FsdDetails = {
  client: string
  feature: string
  product: string
  reference: string
  version: string
  date: string
  author: string
  irippleBA: string
  iripplePM: string
  clientName1: string
  clientTitle1: string
  clientName2: string
  clientTitle2: string
}
export type FsdDraft = {
  uploadFailures?: FsdUploadFailure[]
  mode: FsdMode
  details: FsdDetails
  projectName?: string
  fileNameOverride?: string
  sources: FsdSource[]
  presetId: string
  presetInstructions: string
  customPresets: FsdPreset[]
  presetName: string
  modules: FsdModule[]
  features?: FsdFeature[]
  guidance: string
  mapping: Record<string, string>
  pasteName: string
  pasteText: string
  pasteKind: FsdSource['kind']
  preview: FsdPreview | null
  previewRevision: number
  revision: number
  reviewed: boolean
}
export function emptyFsdDraft(): FsdDraft {
  const d = new Date(),
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return {
    mode: 'advanced',
    details: {
      client: '',
      feature: '',
      product: 'BARTER XI',
      reference: '',
      version: '1.0',
      date,
      author: '',
      irippleBA: '',
      iripplePM: '',
      clientName1: '',
      clientTitle1: '',
      clientName2: '',
      clientTitle2: '',
    },
    projectName: '',
    sources: [],
    presetId: 'standard',
    presetInstructions: FSD_PRESETS[0].instructions,
    customPresets: [],
    presetName: '',
    modules: [...FSD_MODULES],
    guidance: '',
    mapping: {},
    pasteName: '',
    pasteText: '',
    pasteKind: 'Chat',
    preview: null,
    previewRevision: -1,
    revision: 0,
    reviewed: false,
  }
}
export function fsdReference(d: FsdDetails) {
  return (
    d.reference.trim() ||
    `FSD-${
      d.client
        .replace(/[^a-z0-9]/gi, '')
        .toUpperCase()
        .slice(0, 20) || 'CLIENT'
    }-${d.date.slice(0, 4)}-${d.date.slice(5).replace('-', '')}-01`
  )
}
