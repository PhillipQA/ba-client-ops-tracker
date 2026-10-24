import PizZip from 'pizzip'
import { readFsdSource } from '../documents/fsd-sources'

/** Read every worksheet in an externally supplied test-case workbook, not just a fixed RTM template. */
export async function readRtmAiSource(file: File, progress: (message: string) => void): Promise<string> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) return readFsdSource(file, progress)
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error(`${file.name}: use an XLSX workbook up to 5 MB.`)
  progress(`Reading worksheets in ${file.name}…`)
  const zip = new PizZip(await file.arrayBuffer())
  const entries = Object.values(zip.files) as unknown as { _data?: { uncompressedSize?: number } }[]
  if (entries.length > 2000 || entries.reduce((n, e) => n + (e._data?.uncompressedSize || 0), 0) > 30 * 1024 * 1024)
    throw new Error('Workbook expands beyond the safe reading limit. Export the relevant sheets as CSV.')
  const parse = (path: string) => {
    const raw = zip.file(path)?.asText()
    if (!raw || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('Unsupported or missing workbook XML.')
    const doc = new DOMParser().parseFromString(raw, 'application/xml')
    if (doc.querySelector('parsererror')) throw new Error('Damaged workbook XML.')
    return doc
  }
  const texts = (element: Element) => [...element.getElementsByTagName('t')].map(t => t.textContent || '').join('')
  const strings = zip.file('xl/sharedStrings.xml')
    ? [...parse('xl/sharedStrings.xml').getElementsByTagName('si')].map(texts)
    : []
  const sheets = [...parse('xl/workbook.xml').getElementsByTagName('sheet')]
  if (sheets.length > 30) throw new Error('Use a workbook with up to 30 worksheets.')
  const relations = [...parse('xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship')]
  const output: string[] = []
  let chars = 0
  for (const sheet of sheets) {
    const rel = relations.find(r => r.getAttribute('Id') === sheet.getAttribute('r:id')),
      target = rel?.getAttribute('Target') || ''
    if (!target || target.includes('..') || rel?.getAttribute('TargetMode') === 'External')
      throw new Error('Unsupported worksheet reference.')
    const doc = parse(target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    const heading = `[Worksheet: ${sheet.getAttribute('name') || 'Unnamed'}${sheet.getAttribute('state') === 'hidden' || sheet.getAttribute('state') === 'veryHidden' ? ' — hidden' : ''}]`
    output.push(heading)
    chars += heading.length
    for (const row of doc.getElementsByTagName('row')) {
      const cells = [...row.getElementsByTagName('c')]
        .map(c => {
          const raw = c.getElementsByTagName('v')[0]?.textContent || ''
          const value =
            c.getAttribute('t') === 's'
              ? strings[Number(raw)] || ''
              : c.getAttribute('t') === 'inlineStr'
                ? texts(c)
                : raw
          return value ? `${c.getAttribute('r') || ''}: ${value}` : ''
        })
        .filter(Boolean)
        .join(' | ')
      if (!cells) continue
      chars += cells.length + 1
      if (chars > 120000) throw new Error('Workbook text exceeds 120,000 characters. Split it into smaller files.')
      output.push(cells)
    }
  }
  const result = output
    .join('\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (!result || !sheets.length) throw new Error('No readable worksheets were found.')
  return result
}
