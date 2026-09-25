import PizZip from 'pizzip'
import { RTM_STAGES, STAGE_LABELS, stageResult, orderedRequirements, newPhases, RTM_STATUSES, type Requirement, type RtmMatrix, type RtmStore, type RtmStatus } from './rtm'

const xml = (value: unknown) => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
const col = (index: number): string => index >= 26 ? col(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26) : String.fromCharCode(65 + index)
const headers = ['Requirement ID', 'Parent ID', 'Environment', 'Requirement', 'Description', 'Priority', ...RTM_STAGES.flatMap(s => [STAGE_LABELS[s] + ' Status', STAGE_LABELS[s] + ' Code', STAGE_LABELS[s] + ' GAP', STAGE_LABELS[s] + ' Document URL', STAGE_LABELS[s] + ' Section', STAGE_LABELS[s] + ' Linked Work']), 'Impact Review', 'Revision']
function requirementRows(state: RtmStore, matrix: RtmMatrix): string[][] {
  return orderedRequirements(matrix.requirements).map(({ requirement: r }) => [r.code, matrix.requirements.find(p => p.id === r.parentId)?.code || '', r.environment, r.title, r.description, r.priority, ...RTM_STAGES.flatMap(s => { const phase = r.phases[s], result = stageResult(state, matrix, r, s); return [result.status, phase.code, phase.gap, phase.documentUrl, phase.section, result.linked.map(t => `${t.title} [${t.id}]`).join('; ')] }), r.needsReview ? 'Required' : '', String(r.revision)])
}
function worksheet(rows: string[][], headingRow: number, widths = true) {
  const last = `${col(Math.max(...rows.map(r => r.length)) - 1)}${rows.length}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headingRow + 1}" topLeftCell="A${headingRow + 2}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths ? '<cols><col min="1" max="3" width="21" customWidth="1"/><col min="4" max="5" width="48" customWidth="1"/><col min="6" max="44" width="24" customWidth="1"/></cols>' : ''}<sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, c) => `<c r="${col(c)}${i + 1}" t="inlineStr" s="${i === headingRow ? 1 : 0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A${headingRow + 1}:${last}"/></worksheet>`
}
function download(blob: Blob, filename: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
const basename = (name: string) => name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 90) || 'RTM'
export function exportRtm(state: RtmStore, matrix: RtmMatrix, format: 'xlsx' | 'csv') {
  const rows = requirementRows(state, matrix)
  if (format === 'csv') { const cell = (v: string) => `"${(/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`; download(new Blob(['\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), basename(matrix.name) + '.csv'); return }
  const zip = new PizZip(), ns = 'http://schemas.openxmlformats.org'
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1, 2].map(n => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', `<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file('xl/workbook.xml', `<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="RTM" sheetId="1" r:id="rId1"/><sheet name="History" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${ns}/package/2006/relationships">${[1, 2].map(n => `<Relationship Id="rId${n}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('')}<Relationship Id="rId3" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
  zip.file('xl/styles.xml', `<styleSheet xmlns="${ns}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF183B4E"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`)
  zip.file('xl/worksheets/sheet1.xml', worksheet([[matrix.name], ['Client', state.clients.find(c => c.id === matrix.clientId)?.name || '', 'Project', state.projects.find(p => p.id === matrix.projectId)?.name || ''], ['Enhancement', matrix.enhancement, 'CRF / Contract', matrix.contract, 'Version', matrix.version], ['Exported', new Date().toISOString(), 'Owner', state.accounts?.find(a => a.id === matrix.ownerId)?.name || '', 'Environment', matrix.environment], headers, ...rows], 4))
  zip.file('xl/worksheets/sheet2.xml', worksheet([['Date / Time', 'Actor', 'Requirement ID', 'Stage', 'Change', 'Task IDs'], ...matrix.history.map(e => [e.at, e.actorName, matrix.requirements.find(r => r.id === e.requirementId)?.code || e.requirementId || '', e.stage ? STAGE_LABELS[e.stage] : '', e.summary, e.taskIds?.join('; ') || ''])], 0))
  download(new Blob([new Uint8Array(zip.generate({ type: 'uint8array' }))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), basename(matrix.name) + '.xlsx')
}
export function downloadRtmTemplate() { download(new Blob([['Requirement ID,Parent ID,Environment,Requirement,Description,Priority,Documentation Status,Documentation Code,FSD Status,FSD Code,Development Status,Development Code,Testing Status,Testing Code,Presentation / UAT Status,Approval Status', 'REQ-001,,UAT,Sign On,User authentication,High,Not Started,,Not Started,,Not Started,,Not Started,,Not Started,Not Started', 'REQ-002,REQ-001,UAT,Username and password,Valid credentials allow access,High,Not Started,,Not Started,,Not Started,,Not Started,,Not Started,Not Started'].join('\r\n')], { type: 'text/csv' }), 'RTM-import-template.csv') }
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted } else if (c === ',' && !quoted) { row.push(cell); cell = '' } else if ((c === '\r' || c === '\n') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' } else cell += c }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.')
  if (cell || row.length) { row.push(cell); rows.push(row) }; return rows
}
export async function readRtmImport(file: File): Promise<string[][]> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Import files must be 5 MB or smaller.')
  if (file.name.toLowerCase().endsWith('.csv')) return parseCsv(await file.text())
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Choose a CSV or XLSX file.')
  const zip = new PizZip(await file.arrayBuffer())
  // Guard decompression size before materializing workbook XML.
  const entries = Object.values(zip.files) as unknown as { _data?: { uncompressedSize?: number }; dir: boolean }[]
  if (entries.length > 2000 || entries.reduce((n, entry) => n + (entry._data?.uncompressedSize || 0), 0) > 30 * 1024 * 1024) throw new Error('Workbook is too large to import. Use the CSV template.')
  const parse = (path: string) => { const value = zip.file(path)?.asText(); if (!value) throw new Error(`Workbook is missing ${path}.`); const doc = new DOMParser().parseFromString(value, 'application/xml'); if (doc.querySelector('parsererror')) throw new Error('Invalid workbook XML.'); return doc }
  const texts = (element: Element) => [...element.getElementsByTagName('t')].map(t => t.textContent || '').join('')
  const strings = zip.file('xl/sharedStrings.xml') ? [...parse('xl/sharedStrings.xml').getElementsByTagName('si')].map(texts) : []
  const sheet = parse('xl/workbook.xml').getElementsByTagName('sheet')[0], rid = sheet?.getAttribute('r:id')
  const relation = [...parse('xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid), target = relation?.getAttribute('Target') || ''
  if (!target || target.includes('..') || relation?.getAttribute('TargetMode') === 'External') throw new Error('Unsupported workbook sheet reference.')
  const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target
  return [...parse(path).getElementsByTagName('row')].map(row => { const cells: string[] = []; for (const c of row.getElementsByTagName('c')) { const letters = c.getAttribute('r')?.match(/^[A-Z]+/)?.[0] || ''; const index = [...letters].reduce((n, l) => n * 26 + l.charCodeAt(0) - 64, 0) - 1; if (index < 0 || index > 100) continue; const value = c.getElementsByTagName('v')[0]?.textContent || ''; cells[index] = c.getAttribute('t') === 's' ? strings[Number(value)] || '' : c.getAttribute('t') === 'inlineStr' ? texts(c) : value }; return cells })
}
export function importRequirements(rows: string[][], matrix: RtmMatrix): { requirements: Requirement[]; nextNumber: number } {
  const normalize = (s: string) => String(s || '').replace(/^\uFEFF/, '').trim().toLowerCase()
  const index = rows.findIndex(row => row.some(c => ['requirement', 'procedure/requirement', 'procedures', 'requirement title'].includes(normalize(c))))
  if (index < 0) throw new Error('No Requirement column found. Download the CSV template for the supported layout.')
  const titles = rows[index].map(normalize), get = (row: string[], ...names: string[]) => { const col = titles.findIndex(h => names.includes(h)); return col < 0 ? '' : String(row[col] || '').trim() }
  let counter = matrix.nextRequirementNumber
  const codes = new Set(matrix.requirements.map(r => r.code.toLowerCase())), parents: string[] = [], requirements: Requirement[] = []
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i], title = get(row, 'requirement', 'procedure/requirement', 'procedures', 'requirement title'); if (!row.some(c => c?.trim())) continue
    if (!title) throw new Error(`Row ${i + 1}: Requirement is required.`)
    if (requirements.length + matrix.requirements.length >= 2000) throw new Error('An RTM supports up to 2,000 requirements.')
    let code = get(row, 'requirement id', 'requirement code'); if (!code) { do { code = `REQ-${String(counter++).padStart(3, '0')}` } while (codes.has(code.toLowerCase())) }
    if (codes.has(code.toLowerCase())) throw new Error(`Row ${i + 1}: duplicate requirement code ${code}. Import adds new rows; it does not overwrite existing requirements.`); codes.add(code.toLowerCase())
    const phases = newPhases()
    for (const stage of RTM_STAGES) { const label = STAGE_LABELS[stage].toLowerCase(), raw = get(row, `${label} status`); const status = RTM_STATUSES.find(s => s.toLowerCase() === raw.toLowerCase()) || (raw.toLowerCase() === 'pending' ? 'Not Started' : raw.toLowerCase() === 'completed' ? 'Done' : undefined); if (raw && !status) throw new Error(`Row ${i + 1}: unsupported ${label} status “${raw}”.`); phases[stage] = { status: status || 'Not Started' as RtmStatus, code: get(row, `${label} code`), gap: get(row, `${label} gap`, ...(stage === 'documentation' ? ['gap #'] : [])), documentUrl: get(row, `${label} document url`), section: get(row, `${label} section`) } }
    const priorityRaw = get(row, 'priority') || 'Medium', priority = ['Low', 'Medium', 'High', 'Urgent'].find(p => p.toLowerCase() === priorityRaw.toLowerCase()) as Requirement['priority'] | undefined
    if (!priority) throw new Error(`Row ${i + 1}: invalid priority.`)
    parents.push(get(row, 'parent id', 'parent requirement'))
    requirements.push({ id: crypto.randomUUID(), code, parentId: '', title, description: get(row, 'description'), environment: get(row, 'environment') || matrix.environment, priority, revision: 1, needsReview: false, phases })
  }
  if (!requirements.length) throw new Error('The file contains no requirement rows.')
  requirements.forEach((req, i) => { if (parents[i]) { const parent = [...matrix.requirements, ...requirements].find(r => r.code.toLowerCase() === parents[i].toLowerCase()); if (!parent) throw new Error(`Parent ${parents[i]} was not found.`); req.parentId = parent.id } })
  return { requirements, nextNumber: counter }
}
