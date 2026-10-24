import {
  FSD_MODULE_SECTION,
  fsdModuleSection,
  fsdSectionsForModules,
  isCustomFsdFeature,
  type FsdLegacyModule,
  type FsdFeature,
  type FsdModule,
  type FsdSource,
} from './fsd-model'

export type FsdReadinessIssue = {
  category?: 'unavailable' | 'missing-data'
  sourceId?: string
  sectionId?: string
  id: string
  title: string
  missing: string
  add: string
}

const moduleSuggestions: Record<FsdLegacyModule, string> = {
  'MMS Feature':
    'Add workflow notes or screenshots describing the action, user role, inputs, validation and expected result.',
  'MMS Report':
    'Add a sample report, column list or notes describing filters, calculations, data sources and expected output.',
  'Lynexus Feature':
    'Add integration notes or an API specification describing the systems, fields exchanged and expected responses.',
  'POS Feature':
    'Add checkout or transaction notes, screen examples and expected behavior for successful and failed transactions.',
}

export function suggestedFsdSectionInput(id: string) {
  if (isCustomFsdFeature(id))
    return 'Add notes or screenshots describing the feature workflow, scenarios, inputs, expected outputs and field definitions. For reports, include sample columns, filter rules and calculations.'
  const module = (Object.keys(moduleSuggestions) as FsdLegacyModule[]).find(m => FSD_MODULE_SECTION[m] === id)
  if (module) return moduleSuggestions[module]
  if (id === 'acceptance')
    return 'Add test scenarios or notes stating the conditions, expected results and pass/fail rules.'
  if (id === 'functional')
    return 'Describe the workflow, inputs, user actions, validations and expected outputs in notes or screenshots.'
  if (id === 'business' || id === 'summary')
    return 'Paste the business problem, objective, desired change and expected benefit.'
  if (id === 'scope') return 'List the features included in this change and its boundaries for the selected scope.'
  if (id === 'audience') return 'List the stakeholders or user roles who will use or review the feature.'
  return 'Add notes describing the relevant dependencies, assumptions or limitations that need confirmation.'
}

export function suggestedFsdInput(gap: string) {
  if (/unreadable|illegible|extract|OCR|visual|image|layout/i.test(gap))
    return 'Upload a clearer copy or paste the readable text. Describe any important diagram or screen relationship in words.'
  if (/split|entire source|incomplete review/i.test(gap))
    return 'Split the document into smaller files or paste the missing paragraphs. Generate anyway can use the parts already reviewed.'
  if (/endpoint|API|integration|payload|interface|data format|response|timeout/i.test(gap))
    return 'Add an API specification, sample request/response or plain-text integration notes with the missing fields and error behavior.'
  if (/calculat|formula|total|currency|round|amount/i.test(gap))
    return 'Add the calculation or currency rule in plain text, with a worked example or annotated sample report.'
  if (/report|column|filter|data source/i.test(gap))
    return 'Add a sample report or paste its column definitions, filter rules and data sources.'
  if (/type|length|mandatory|optional|field|dictionary/i.test(gap))
    return 'Add a field list or data dictionary with types, lengths, required fields and validation rules.'
  if (/role|permission|stakeholder|audience|actor/i.test(gap))
    return 'List the users or roles involved and the actions each can perform; notes or a role matrix are sufficient.'
  if (/acceptance|expected|scenario|exception|error|flow|process|step/i.test(gap))
    return 'Paste the workflow steps, expected result and exception behavior, or add meeting notes or test scenarios covering them.'
  if (/scope|module|applicab/i.test(gap))
    return 'Describe which selected module this change affects and what it should do. You can also map the source to that section.'
  if (/objective|goal|benefit|business/i.test(gap))
    return 'Add a short description of the business problem, desired change and expected benefit; a formal BRD is optional.'
  return 'Answer this point in pasted notes or add a supporting document or annotated screenshot containing the missing detail.'
}

/** Guidance reflects the current source review, not a required list of file types. */
export function fsdReadiness(
  sources: FsdSource[],
  modules: readonly FsdModule[],
  features?: readonly FsdFeature[],
  uploadFailures: { id: string; name: string; reason: string }[] = [],
): FsdReadinessIssue[] {
  const selected = new Set<string>(fsdSectionsForModules(modules, features).map(([id]) => id))
  const included = sources.filter(s => !s.target || selected.has(s.target))
  const issues: FsdReadinessIssue[] = uploadFailures.map(f => ({
    id: f.id,
    category: 'unavailable',
    title: f.name,
    missing: `Upload unavailable: ${f.reason}`,
    add: 'Replace this file or paste its readable contents. Generate anyway skips this unavailable upload.',
  }))
  for (const source of sources.filter(s => s.target && !selected.has(s.target)))
    issues.push({
      id: `${source.id}-excluded`,
      category: 'unavailable',
      sourceId: source.id,
      title: source.name,
      missing: 'Excluded by section mapping; this input will not be used.',
      add: 'Reassign to an included feature or shared section to use its content.',
    })
  if (!included.length)
    return [
      {
        id: 'source',
        title: 'Requirement information',
        missing: sources.length
          ? 'Your sources are mapped only to unchecked modules.'
          : 'No requirement information has been added.',
        add: sources.length
          ? 'Select the relevant module or change a source mapping to an included section.'
          : 'Upload any relevant file or paste a few notes explaining the desired change. A BRD is optional.',
      },
      ...issues,
    ]
  for (const source of included) {
    const review = source.analysis
    if (source.analysisError)
      issues.push({
        id: `${source.id}-failed`,
        title: source.name,
        missing: `Source review failed: ${source.analysisError}`,
        add: 'Retry AI review or paste clearer notes. Generate anyway skips this source if its review still fails.',
      })
    else if (!review)
      issues.push({
        id: `${source.id}-pending`,
        title: source.name,
        missing: 'This source has not been reviewed yet.',
        add: 'Generate preview will review it first, or use Analyze source above to see what was understood.',
      })
    else {
      if (review.readability === 'unreadable')
        issues.push({
          id: `${source.id}-unreadable`,
          title: source.name,
          missing: 'No usable text was understood from this source.',
          add: 'Replace it with a clearer copy or paste its contents. Generate anyway skips unreadable sources.',
        })
      else if (!review.complete || review.readability === 'partial')
        issues.push({
          id: `${source.id}-partial`,
          title: source.name,
          missing: 'Only part of this source could be reviewed or read reliably.',
          add: 'Add the missing text or describe unclear visuals. Generate anyway uses verified readable portions and marks the rest pending.',
        })
      if (review.readability !== 'unreadable' && !review.requirements.length)
        issues.push({
          id: `${source.id}-facts`,
          title: source.name,
          missing: 'The review found no supported facts or requirements for the selected scope.',
          add: 'Paste a sentence describing what should change, the affected module and the expected result. Generate anyway can create a draft with TBD sections.',
        })
      review.gaps.forEach((gap, index) =>
        issues.push({
          id: `${source.id}-gap-${index}`,
          title: `${source.name} — clarification`,
          missing: gap,
          add: suggestedFsdInput(gap),
        }),
      )
    }
  }
  if (included.some(s => s.analysis && !s.analysisError)) {
    const facts = included.flatMap(s =>
      s.analysisError || s.analysis?.readability === 'unreadable' ? [] : s.analysis?.requirements || [],
    )
    for (const module of modules)
      if (!facts.some(r => r.module === module))
        issues.push({
          id: `module-${fsdModuleSection(module)}`,
          title: features?.find(f => f.id === module)?.name || module,
          missing: 'No feature-specific requirements were identified. Applicability and behavior remain pending.',
          add: isCustomFsdFeature(module) ? suggestedFsdSectionInput(module) : moduleSuggestions[module],
        })
  }
  return issues.map(issue => ({
    ...issue,
    category:
      issue.category || (/-(failed|pending|unreadable|partial)$/.test(issue.id) ? 'unavailable' : 'missing-data'),
    sourceId: issue.sourceId || included.find(s => issue.id.startsWith(`${s.id}-`))?.id,
    sectionId: issue.id.startsWith('module-') ? issue.id.slice(7) : undefined,
  }))
}
