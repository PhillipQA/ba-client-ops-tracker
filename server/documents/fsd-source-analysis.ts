import { createHash } from 'node:crypto'
import { FSD_MODULES, FSD_SECTIONS, fsdExcludedModules, fsdSectionsForModules, type FsdModule, type FsdSource, type FsdSourceAnalysis, type FsdSourceCoverage } from '../../src/fsd-model'
import { IntegrationError } from '../integrations/tenant-integrations'
import { interpretationInstructions, interpretRequirements, rejectExcludedMentions } from './fsd-grounding'

export function validateSourceAnalysisInput(body: any) {
  const modules = body?.modules as FsdModule[]
  if (!Array.isArray(modules) || modules.some(m => !FSD_MODULES.includes(m)) || new Set(modules).size !== modules.length) throw new IntegrationError('Invalid module selection.')
  const value = body?.source
  const field = (key: string, max: number, required = true) => {
    const text = value?.[key] ?? (key === 'target' ? '' : undefined)
    if (typeof text !== 'string' || text.length > max || required && !text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new IntegrationError(`Invalid source ${key}.`)
    return text.trim()
  }
  const source: FsdSource = { id: field('id', 80), name: field('name', 200), text: field('text', 120000), target: field('target', 80, false), kind: value?.kind }
  if (!['BRD', 'Meeting notes', 'Supporting document', 'Chat'].includes(source.kind) || source.target && !FSD_SECTIONS.some(([id]) => id === source.target)) throw new IntegrationError('Invalid source type or section mapping.')
  if (source.target && !fsdSectionsForModules(modules).some(([id]) => id === source.target)) throw new IntegrationError('This source is mapped to an unchecked module. It is excluded from AI review and generation.')
  return { source, modules }
}

export function sourceAnalysisFingerprint(source: FsdSource, modules: readonly FsdModule[]) {
  return createHash('sha256').update(JSON.stringify([1, source.id, source.name, source.kind, source.target, source.text, [...modules].sort()])).digest('hex')
}

export function sourceAnalysisInstructions(modules: FsdModule[]) {
  return `${interpretationInstructions}
This is a source review before document generation. Read the entire supplied source for the selected scope. Return JSON with these additional fields:
"readability": "readable|partial|unreadable", "summary": "brief explanation of what this source establishes for the selected scope", "complete": true.
Use partial when text is understandable only in part or extraction warnings exist. Use unreadable only when no meaningful content can be understood, with an empty requirements array. A readable reference document can have zero relevant requirements; explain that in summary without inventing any.
There is no minimum document length and no required document type. A short note, field list, report title or single sentence may establish useful supported facts. Extract those facts even when workflow details are missing; list the specific missing details as gaps with concrete questions. A lack of a formal BRD is not itself a gap.
Extract supported facts, definitions, actors, rules, conditions, limits, exceptions and requirements into the requirements array, each with exact source excerpts. Never repair illegible words or numbers by guessing. Record ambiguity, contradictions and unreadable sections as gaps. Treat visual relationships as unknown: you have extracted text, not visual understanding. Do not treat extraction notices as business requirements.
For OCR from report screenshots, identify report titles, displayed fields, categories and clearly stated notes when their text is legible. Treat table figures and dashboard totals as illustrative data, not required thresholds, formulas or acceptance values unless the source explicitly defines them. If a calculation, date filter, data source or transaction rule is missing, record it as a gap rather than deriving it from sample rows.
Set complete to false if you cannot review the entire supplied text or more than 120 facts/requirements are needed; explain that the source must be split. Never silently drop content to fit a limit.
Only interpret these software modules: ${JSON.stringify(modules)}. Hard-excluded modules: ${JSON.stringify(fsdExcludedModules(modules))}. Ignore passages that belong only to excluded modules; do not extract, summarize, mention or list them in any output field. General facts must apply independently of a software module. If explicit source.target maps to a module, honor that mapping.
This review is independent of a writing preset. Presets are applied later to all current sources together; they never create evidence.`
}

export function sourceHasReadableText(text: string) {
  const content = text.replace(/\[(?:Extraction warning:|Page \d+|OCR text|Selectable text|Embedded image:|No readable text;)[^\]]*\]/g, '').trim()
  return /[\p{L}\p{N}]/u.test(content)
}

export function validateSourceAnalysis(value: any, source: FsdSource, modules: FsdModule[]) {
  if (!['readable', 'partial', 'unreadable'].includes(value?.readability) || typeof value?.summary !== 'string' || !value.summary.trim() || value.summary.length > 3000 || typeof value.complete !== 'boolean' || !Array.isArray(value.gaps) || value.gaps.length > 100 || value.gaps.some((g: unknown) => typeof g !== 'string' || !g.trim() || g.length > 2000)) throw new IntegrationError('The AI source review was incomplete or invalid. Your source text is retained; retry analysis.', 422)
  const grounding = interpretRequirements(value, [source], modules, true)
  let readability: FsdSourceAnalysis['readability'] = value.readability
  if (!sourceHasReadableText(source.text)) readability = 'unreadable'
  if (readability === 'unreadable' && grounding.requirements.length) throw new IntegrationError('The AI reported an unreadable source but still inferred requirements. Review the source and retry.', 422)
  if (source.text.includes('[Extraction warning:') && readability === 'readable') readability = 'partial'
  const gaps = [...grounding.gaps]
  if (source.text.includes('[Extraction warning:')) gaps.unshift('Extraction warnings are present. Check the original for unclear text, omitted visuals and layout before relying on this review.')
  if (!value.complete) gaps.unshift('The entire source could not be represented. Split it into smaller sources and analyze again, or generate anyway using the verified portions.')
  const normalizedGaps = [...new Set(gaps)]
  if (normalizedGaps.length > 100) throw new IntegrationError('This source has too many unresolved reading issues. Split it into smaller sources and analyze again.', 422)
  rejectExcludedMentions([value.summary, ...normalizedGaps].join('\n'), modules)
  return { readability, summary: value.summary.trim(), complete: value.complete, requirements: grounding.requirements, gaps: normalizedGaps }
}

/** Reuse analyses only for the exact source and scope that were reviewed. */
export function groundingFromSourceAnalyses(sources: FsdSource[], rawSources: FsdSource[], modules: FsdModule[], allowIncomplete = false) {
  const requirements: FsdSourceAnalysis['requirements'] = [], gaps: string[] = []
  const sourceCoverage: FsdSourceCoverage = { usedSourceIds: [], partialSourceIds: [], skippedSources: [] }
  const skip = (source: FsdSource, reason: string) => {
    sourceCoverage.skippedSources.push({ id: source.id, name: source.name, reason })
    gaps.push(`${source.name}: skipped — ${reason}`.slice(0, 2000))
  }
  for (const source of sources) {
    const raw = rawSources.find(s => s.id === source.id)
    const analysis = raw?.analysis
    if (allowIncomplete && (!analysis || raw?.analysisError)) { skip(source, 'No successful source review is available. Retry AI review or paste clearer notes.'); continue }
    if (!analysis || analysis.fingerprint !== sourceAnalysisFingerprint(source, modules)) throw new IntegrationError(`${source.name}: source or scope changed. Analyze this source again before generating.`, 422)
    const current = validateSourceAnalysis(analysis, source, modules)
    if (current.readability === 'unreadable') {
      if (allowIncomplete) { skip(source, 'No readable content was understood. Add a clearer copy or paste its contents.'); continue }
      throw new IntegrationError(`${source.name}: no usable content was understood. Add a clearer copy or paste its contents, or choose Generate anyway to skip it.`, 422)
    }
    if (!current.complete && !allowIncomplete) throw new IntegrationError(`${source.name}: the review is incomplete. Split the file into smaller sources, or choose Generate anyway to use its verified portions.`, 422)
    sourceCoverage.usedSourceIds.push(source.id)
    if (!current.complete || current.readability === 'partial') sourceCoverage.partialSourceIds.push(source.id)
    for (const requirement of current.requirements) requirements.push({ ...requirement, id: `REQ-${String(requirements.length + 1).padStart(3, '0')}` })
    gaps.push(...current.gaps.map(g => `${source.name}: ${g}`.slice(0, 2000)))
  }
  if (allowIncomplete && !sourceCoverage.usedSourceIds.length) throw new IntegrationError('No readable reviewed content is available. Upload a clearer file or paste a few notes describing the desired change, then retry AI review. Missing documents can be skipped, but at least one readable source is needed.', 422)
  if (requirements.length > 120 || gaps.length > 100) throw new IntegrationError('The combined source review is too large for one FSD. Split the feature into smaller documents; no requirements have been discarded.', 422)
  return { ...interpretRequirements({ requirements, gaps }, sources, modules, allowIncomplete), sourceCoverage }
}
