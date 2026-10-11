import PizZip from 'pizzip'
import type { SignoffInput } from '../../src/signoff'

const visible = (value: string) => value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
function emptyCell(cell: string) {
  return cell.replace(/(<w:tc(?:\s[^>]*)?>)([\s\S]*)(<\/w:tc>)/, (_all, open, body, close) => {
    const properties = (body.match(/<w:tcPr[ >][\s\S]*?<\/w:tcPr>/)?.[0] || '<w:tcPr></w:tcPr>').replace(/<w:tcBorders[ >][\s\S]*?<\/w:tcBorders>/g, '').replace('</w:tcPr>', '<w:tcBorders><w:top w:val="nil"/><w:bottom w:val="nil"/></w:tcBorders></w:tcPr>')
    return `${open}${properties}<w:p/>${close}`
  })
}

/** Keep the template's approval-table style while matching the actual signer count. */
export function prepareSignoffTemplate(template: Buffer, details: SignoffInput) {
  const zip = new PizZip(template)
  let body = zip.file('word/document.xml')!.asText()
  let mapped = false
  body = body.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, table => {
    if (!table.includes('{iripple_name_1}') || !table.includes('{client_name_1}')) return table
    const rows = table.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || []
    const signerRows = rows.filter(row => /\{(?:iripple|client)_name_\d+\}/.test(row))
    if (!signerRows.length) return table
    mapped = true
    const model = signerRows[0]
    const count = Math.max(details.irippleSignatories.length, details.clientSignatories.length)
    const replacements = Array.from({ length: count }, (_, i) => {
      let row = model.replace(/\{((?:iripple|client)_(?:name|title))_\d+\}/g, `{$1_${i + 1}}`)
      row = /<w:cantSplit\b/.test(row) ? row.replace(/<w:cantSplit\b[^>]*\/>/, '<w:cantSplit/>') : row.includes('<w:trPr>') ? row.replace('<w:trPr>', '<w:trPr><w:cantSplit/>') : row.replace(/(<w:tr(?:\s[^>]*)?>)/, '$1<w:trPr><w:cantSplit/></w:trPr>')
      const cells = row.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []
      let index = 0
      row = row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, cell => {
        const n = index++
        const left = cells.length === 2 ? n === 0 : n < 3
        const right = cells.length === 2 ? n === 1 : n >= 4
        if (left && i >= details.irippleSignatories.length || right && i >= details.clientSignatories.length) return emptyCell(cell)
        // A lower border on the final row looks like another blank signer slot.
        return cells.length === 7 ? cell.replace(/<w:bottom\b[^>]*\/>/g, '<w:bottom w:val="nil"/>') : cell
      })
      return row
    }).join('')
    let inserted = false
    return table.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => {
      if (!signerRows.includes(row)) return row
      if (inserted) return ''
      inserted = true; return replacements
    })
  })
  if (!mapped) throw new Error('The template needs an approval table containing {iripple_name_1} and {client_name_1} to support additional signatories.')
  // Older custom production templates contain fixed section text rather than mapping tags.
  const fields: Record<string, string> = { Purpose: 'purpose', Scope: 'scope', 'Deployment Authorization': 'deployment_authorization' }
  if (details.formType !== 'golive') body = body.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => {
    const cells = row.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []
    const field = fields[visible(cells[0] || '')]
    if (!field || cells.length !== 2) return row
    const cell = cells[1]
    const tcPr = cell.match(/<w:tcPr[ >][\s\S]*?<\/w:tcPr>/)?.[0] || ''
    const pPr = (cell.match(/<w:pPr[ >][\s\S]*?<\/w:pPr>/)?.[0] || '<w:pPr></w:pPr>').replace(/<w:jc\b[^>]*\/>/g, '').replace('</w:pPr>', '<w:jc w:val="left"/></w:pPr>')
    const rPr = cell.match(/<w:rPr[ >][\s\S]*?<\/w:rPr>/)?.[0] || ''
    const replacement = cell.replace(/(<w:tc(?:\s[^>]*)?>)[\s\S]*?(<\/w:tc>)/, `$1${tcPr}<w:p>${pPr}<w:r>${rPr}<w:t>{${field}}</w:t></w:r></w:p>$2`)
    return row.replace(cell, replacement)
  })
  zip.file('word/document.xml', body)
  return zip.generate({ type: 'nodebuffer' })
}
