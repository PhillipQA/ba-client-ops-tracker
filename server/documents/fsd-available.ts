import { fsdReadiness, suggestedFsdSectionInput } from '../../src/fsd-readiness'
import type { FsdSectionId, FsdSource, FsdModule, FsdBlock, FsdFeature } from '../../src/fsd-model'
import { IntegrationError } from '../integrations/tenant-integrations'

export function pendingFsdSection(id: FsdSectionId, title: string) {
  return { id, title, sourceIds: [], blocks: [{ type: 'paragraph' as const, text: `TBD — Pending information for ${title.replace(/^[\d.]+\s*/, '')}. Add relevant notes or supporting evidence to complete this section.`, requirementIds: [] }] }
}

/** Keep the chosen template structure even when a sparse model reply omits sections. */
export function completeAvailableSections(value: any, sections: readonly (readonly [FsdSectionId, string])[]) {
  if (!Array.isArray(value?.sections)) throw new IntegrationError('The AI returned an invalid preview. Retry generation; your sources are retained.', 422)
  const ids = value.sections.map((s: any) => s?.id)
  if (new Set(ids).size !== ids.length || ids.some((id: any) => !sections.some(([expected]) => expected === id))) throw new IntegrationError('The AI included a duplicate, unknown or unchecked section. Regenerate the preview.', 422)
  return { ...value, sections: sections.map(([id, title]) => {
    const section = value.sections.find((s: any) => s.id === id)
    if (!section) return pendingFsdSection(id, title)
    // Structural tables can be supplied without guessing their missing values.
    if (!Array.isArray(section.blocks) || !section.blocks.length) return section
    const blocks = [...section.blocks]
    const whollyPending = blocks.length === 1 && blocks[0]?.type === 'paragraph' && /^TBD\b/i.test(blocks[0].text || '')
    if (whollyPending) return section
    if (id === 'acceptance' && !blocks.some(b => b?.type === 'table' && b.headers?.length === 3 && /ac.*id/i.test(b.headers[0]))) blocks.push({ type: 'table', headers: ['AC ID', 'Scenario / Condition', 'Expected Result / Pass Criteria'], rows: [['TBD — Pending information', 'TBD — Scenario to confirm', 'TBD — Expected result to confirm']], requirementIds: [] })
    if (['mms', 'report', 'lynexus', 'pos'].includes(id)) {
      const refs = [...new Set<string>(blocks.flatMap(b => Array.isArray(b?.requirementIds) ? b.requirementIds : []))]
      const labels = ['PROCESS NAME','SCENARIO','SUB SCENARIO','PROCESS SCOPE','PROCESS DESCRIPTION','PROCESS INPUT','PROCESS FLOW','PROCESS OUTPUT']
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (block?.type === 'table' && block.headers?.length === 2 && Array.isArray(block.rows) && block.rows.every((r: any) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string')) {
          const missing = labels.filter(label => !block.rows.some((r: string[]) => r[0].trim().toUpperCase() === label))
          blocks[i] = { ...block, rows: [...block.rows, ...missing.map(label => [label, 'TBD — Pending information'])] }
        }
      }
      if (!blocks.some(b => b?.type === 'table' && b.headers?.length === 2)) blocks.push({ type: 'table', headers: ['Field', 'Specification'], rows: labels.map(label => [label, 'TBD — Pending information']), requirementIds: refs })
      const columns = id === 'report' ? ['Column Name','Data Type','Size / Length','Business Rule / Constraint','Sample Value'] : ['Field Name','Module','Data Type','Length','Null / Mandatory','Business Rule / Constraint']
      if (!blocks.some(b => b?.type === 'table' && b.headers?.length === columns.length)) blocks.push({ type: 'table', headers: columns, rows: [columns.map(() => 'TBD — Pending information')], requirementIds: [] })
    }
    return { ...section, blocks: blocks as FsdBlock[] }
  }) }
}

export function availableFsdGaps(sources: FsdSource[], modules: FsdModule[], existing: string[], sections: { id: string; title: string; blocks: FsdBlock[] }[], features?: FsdFeature[]) {
  const notes = [...existing]
  for (const issue of fsdReadiness(sources, modules, features)) notes.push(`${issue.title}: ${issue.missing} What to add: ${issue.add}`.slice(0, 2000))
  for (const section of sections) if (!['history', 'acknowledgement', 'references'].includes(section.id) && section.blocks.some(b => b.type === 'paragraph' ? /^TBD\b/i.test(b.text) : b.rows.some(row => row.some(cell => /^TBD\b/i.test(cell))))) notes.push(`${section.title}: pending information. What to add: ${suggestedFsdSectionInput(section.id)}`)
  const unique = [...new Set(notes)]
  // Preserve every issue without producing an export that cannot be validated.
  if (unique.length > 100) throw new IntegrationError('This draft has more than 100 review items. Split the feature into smaller documents so all pending information remains visible.', 422)
  return unique
}
