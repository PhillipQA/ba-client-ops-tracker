import { fsdFeatureCode } from '../../src/features/documents/fsd-features'
import type { FsdBlock, FsdFeature, FsdSection } from '../../src/features/documents/fsd-model'

export const FSD_PROCESS_LABELS = [
  'PROCESS NAME',
  'SCENARIO',
  'SUB SCENARIO',
  'PROCESS SCOPE',
  'PROCESS DESCRIPTION',
  'PROCESS INPUT',
  'PROCESS FLOW',
  'PROCESS OUTPUT',
]

/** Codes and headings are document metadata; missing process behavior remains TBD. */
export function normalizeFeaturePreview(value: any, features: FsdFeature[], client: string) {
  if (!Array.isArray(value?.sections)) return value
  return {
    ...value,
    sections: value.sections.map((section: any) => {
      const index = features.findIndex(f => f.id === section?.id)
      if (index < 0 || !Array.isArray(section.blocks)) return section
      const feature = features[index],
        code = fsdFeatureCode(client, index)
      const blocks: FsdBlock[] = section.blocks.map((block: any) =>
        block?.type === 'table'
          ? {
              ...block,
              rows: Array.isArray(block.rows)
                ? block.rows.map((row: any) => (Array.isArray(row) ? [...row] : row))
                : block.rows,
            }
          : { ...block },
      )
      let tables = blocks.filter(b => b.type === 'table' && b.headers?.length === 2)
      if (!tables.length) {
        const refs = [...new Set(blocks.flatMap(b => b.requirementIds || []))]
        const process: FsdBlock = {
          type: 'table',
          headers: ['Field', 'Specification'],
          rows: FSD_PROCESS_LABELS.map(label => [label, 'TBD — Pending information']),
          requirementIds: refs,
        }
        blocks.push(process)
        tables = [process]
      }
      const description = (text: string) =>
        text.replace(/^[A-Z0-9]+-(?:FEATURE|MMS(?:-RPT)?|POS|LYN)(?:-\d+)+\s*[-–—:]?\s*/i, '').trim() ||
        'TBD — Pending information'
      tables.forEach((table, tableIndex) => {
        if (
          table.type !== 'table' ||
          !Array.isArray(table.rows) ||
          table.rows.some(row => !Array.isArray(row) || row.length !== 2 || row.some(cell => typeof cell !== 'string'))
        )
          return
        for (const label of FSD_PROCESS_LABELS)
          if (!table.rows.some(row => row[0].trim().toUpperCase() === label))
            table.rows.push([label, 'TBD — Pending information'])
        const row = (label: string) => table.rows.find(row => row[0].trim().toUpperCase() === label)!
        row('PROCESS NAME')[1] = `${code} - ${feature.name}`
        const scenario = `${code}-${String(tableIndex + 1).padStart(2, '0')}`
        row('SCENARIO')[1] = `${scenario} - ${description(row('SCENARIO')[1])}`
        row('SUB SCENARIO')[1] = `${scenario}-01 - ${description(row('SUB SCENARIO')[1])}`
        // Ensure the output order matches the process table in the supplied template.
        table.rows.sort((a, b) => {
          const ai = FSD_PROCESS_LABELS.indexOf(a[0].trim().toUpperCase()),
            bi = FSD_PROCESS_LABELS.indexOf(b[0].trim().toUpperCase())
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
        })
      })
      if (!blocks.some(b => b.type === 'table' && [5, 6].includes(b.headers?.length)))
        blocks.push({
          type: 'table',
          headers: ['Field Name', 'Module', 'Data Type', 'Length', 'Null / Mandatory', 'Business Rule / Constraint'],
          rows: [Array(6).fill('TBD — Pending information')],
          requirementIds: [],
        })
      return { ...section, title: `5.${index + 1} ${feature.name}`, blocks }
    }),
  }
}

export function pendingFeatureMetadataTable(block: FsdBlock, section: FsdSection, features: FsdFeature[]) {
  const feature = features.find(f => f.id === section.id)
  if (!feature || block.type !== 'table' || block.headers.length !== 2 || block.rows.length !== 8) return false
  return block.rows.every(([label, value]) => {
    if (!FSD_PROCESS_LABELS.includes(label)) return false
    if (label === 'PROCESS NAME') return /^[A-Z0-9]+-FEATURE-\d+ - /.test(value) && value.endsWith(` - ${feature.name}`)
    if (label === 'SCENARIO' || label === 'SUB SCENARIO')
      return /^[A-Z0-9]+-FEATURE-\d+(?:-\d+){1,2} - TBD\b/.test(value)
    return /^TBD\b/i.test(value)
  })
}
