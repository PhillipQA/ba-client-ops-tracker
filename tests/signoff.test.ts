import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import PizZip from 'pizzip'
import { renderSignoff, registerSignoffRoutes, validateSignoff } from '../server/documents/signoff-documents'
import { DEPLOYMENT_TYPES, DEPLOYED_PRODUCTS, SIGNOFF_PURPOSE, SIGNOFF_MAX_FILE_BYTES, SIGNOFF_MAX_SIGNATORIES, GO_LIVE_SECTION_FIELDS, GO_LIVE_TYPES, formatDeploymentDate, type SignoffInput } from '../src/signoff'

const templatePath = new URL('../templates/signoff-template.docx', import.meta.url).pathname
const template = await readFile(templatePath)
const goLiveTemplatePath = new URL('../templates/golive-template.docx', import.meta.url).pathname
const goLiveTemplate = await readFile(goLiveTemplatePath)
const png = await readFile(new URL('./fixtures/signoff-evidence.png', import.meta.url))
const jpg = await readFile(new URL('./fixtures/signoff-evidence.jpg', import.meta.url))
const input = () => ({ clientName: 'Example & Partners <Retail>', deploymentDate: '2026-09-25', deploymentType: 'Production - Branch', product: 'Barter CX v1.0', site: 'BR-001 & Main', documentYear: '2026', documentNumber: '7', irippleSignatories: [1, 2, 3].map(i => ({ name: `iRipple Person ${i}`, title: `iRipple Role ${i}` })), clientSignatories: [1, 2, 3].map(i => ({ name: `Client Person ${i}`, title: `Client Role ${i}` })) })
const goLiveInput = (): SignoffInput => ({ ...input(), formType: 'golive', projectName: 'Retail rollout & pilot', preparedBy: 'Approved Author', documentDate: '2026-09-28', goLiveType: 'Pilot Branch', site: '', irippleSignatories: input().irippleSignatories.slice(0, 2), clientSignatories: input().clientSignatories.slice(0, 2), sections: Object.fromEntries(GO_LIVE_SECTION_FIELDS.map(([key, label]) => [key, `${label}: edited & verified\nSecond line <details>`])) })
const textOf = (xml: string) => Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g), m => m[1]).join('')
const image = (name = 'evidence.png') => ({ name, data: png.toString('base64'), caption: 'Sample & verified' })

test('Word output retains header/logo and fixed sections, populates every client reference and all six signatories', async () => {
  const rendered = await renderSignoff(template, input())
  assert.equal(rendered.fileName, 'PAF-EXAMPLEPARTNERSRETAIL-2026-07.docx')
  const zip = new PizZip(rendered.output), original = new PizZip(template)
  assert.deepEqual(zip.file('word/media/image3.jpg')!.asNodeBuffer(), original.file('word/media/image3.jpg')!.asNodeBuffer())
  const body = textOf(zip.file('word/document.xml')!.asText()), header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('PRODUCTION DEPLOYMENT APPROVAL FORM'))
  assert(header.includes('PAF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert.equal((body.match(/Example &amp; Partners &lt;Retail&gt;/g) || []).length, 3)
  assert(body.includes('09/25/2026')); assert(body.includes('Barter CX v1.0')); assert(body.includes('BR-001 &amp; Main'))
  for (let i = 1; i <= 3; i++) for (const side of ['iRipple', 'Client']) { assert(body.includes(`${side} Person ${i}`)); assert(body.includes(`${side} Role ${i}`)) }
  assert(body.includes(SIGNOFF_PURPOSE)); assert(body.includes('New Site configuration')); assert(body.includes('POS Terminal Setup')); assert(body.includes('Deployment Authorization'))
  assert(!body.includes('Deployment History')); assert(!body.includes('CARD INDOGROSIR')); assert(!body.includes('{@attachments}'))
  assert.equal(Object.keys(zip.files).filter(n => n.startsWith('word/media/')).length, 1)
})

test('all dropdown choices are accepted; invalid values, impossible dates, and missing fields are rejected', () => {
  for (const deploymentType of DEPLOYMENT_TYPES) for (const product of DEPLOYED_PRODUCTS) assert.equal(validateSignoff({ ...input(), deploymentType, product }).product, product)
  assert.equal(formatDeploymentDate('2028-02-29'), '02/29/2028')
  for (const date of ['2026-02-29', '2026-04-31', '09/25/2026', '', '2026-00-01']) assert.throws(() => formatDeploymentDate(date))
  for (const patch of [{ clientName: '' }, { site: '' }, { deploymentType: 'Sandbox' }, { product: 'Other' }, { documentNumber: '0' }, { documentYear: '26' }, { clientSignatories: [] }, { clientName: 'bad\u0000name' }]) assert.throws(() => validateSignoff({ ...input(), ...patch }))
})

test('edited production sections replace the original wording and preserve multiline text safely', async () => {
  const sections = { purpose: 'Branch activation & approval\nReviewed <scope>', scope: 'Branch devices only\nPOS 01\nPOS 02', deployment_authorization: '' }
  const result = await renderSignoff(template, { ...input(), sections })
  const body = new PizZip(result.output).file('word/document.xml')!.asText()
  assert(body.includes('Branch activation &amp; approval')); assert(body.includes('Reviewed &lt;scope&gt;')); assert(body.includes('<w:br/>'))
  assert(!textOf(body).includes(SIGNOFF_PURPOSE)); assert(!textOf(body).includes('New Site configuration'))
  assert(!textOf(body).includes('approval is hereby granted')); assert(textOf(body).includes('POS 02'))
})

test('Go Live output maps all required fields and editable sections without sample people or dates', async () => {
  const result = await renderSignoff(goLiveTemplate, goLiveInput(), [image()])
  assert.equal(result.fileName, 'SOF-EXAMPLEPARTNERSRETAIL-2026-07.docx'); assert.equal(result.imageCount, 1)
  const zip = new PizZip(result.output), original = new PizZip(goLiveTemplate)
  const body = textOf(zip.file('word/document.xml')!.asText()), header = textOf(zip.file('word/header1.xml')!.asText())
  assert(header.includes('GO LIVE SIGN OFF')); assert(header.includes('SOF-EXAMPLEPARTNERSRETAIL-2026-07'))
  assert(header.includes('Approved Author')); assert(header.includes('09/28/2026'))
  assert(body.includes('09/25/2026')); assert(body.includes('Pilot Branch')); assert(body.includes('Retail rollout &amp; pilot'))
  assert(body.includes('Example &amp; Partners &lt;Retail&gt;')); assert(body.includes('Barter CX v1.0'))
  for (const [, label] of GO_LIVE_SECTION_FIELDS) assert(body.includes(`${label}: edited &amp; verified`))
  assert(body.includes('Second line &lt;details&gt;')); assert(!body.includes('iripple_name_3')); assert(!body.includes('undefined'))
  assert(!header.includes('Jiane')); assert(!header.includes('January 15, 2026')); assert(!body.includes('Branch 1 - mm/dd/yyyy'))
  assert.deepEqual(zip.file('word/media/image1.jpg')!.asNodeBuffer(), original.file('word/media/image1.jpg')!.asNodeBuffer())
})

test('both layouts support two initial signatories and additional approvers on either side', async () => {
  for (const [bytes, details] of [[template, input()], [goLiveTemplate, goLiveInput()]] as const) {
    for (const [left, right] of [[2, 2], [5, 2], [2, 5], [4, 4]]) {
      const people = (side: string, count: number) => Array.from({ length: count }, (_, i) => ({ name: `${side} approver ${i + 1}`, title: `Role ${i + 1}` }))
      const result = await renderSignoff(bytes, { ...details, irippleSignatories: people('iRipple', left), clientSignatories: people('Client', right) })
      const body = new PizZip(result.output).file('word/document.xml')!.asText(), approval = body.match(/<w:tbl[ >][\s\S]*?<\/w:tbl>/)![0]
      assert.equal((approval.match(/<w:tr[ >]/g) || []).length, Math.max(left, right) + 1)
      for (let i = 1; i <= left; i++) assert(textOf(approval).includes(`iRipple approver ${i}`))
      for (let i = 1; i <= right; i++) assert(textOf(approval).includes(`Client approver ${i}`))
      assert(!textOf(approval).includes('undefined')); assert(!textOf(approval).includes('{client_'))
      if (left !== right) {
        const finalRow = [...approval.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].at(-1)![0]
        const cells = [...finalRow.matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map(m => m[0])
        const unused = left < right ? cells[0] : cells.at(-1)!
        assert.equal(textOf(unused), '')
      }
    }
  }
})

test('Go Live validation rejects missing required fields and unsafe sections or signer counts', () => {
  for (const goLiveType of GO_LIVE_TYPES) assert.equal(validateSignoff({ ...goLiveInput(), goLiveType }).go_live_type, goLiveType)
  for (const patch of [{ formType: 'unknown' }, { projectName: '' }, { preparedBy: '' }, { documentDate: '2026-02-29' }, { goLiveType: 'Other' }, { sections: [] }, { sections: { introduction: 'x'.repeat(12001) } }, { sections: { introduction: '\u0000' } }, { irippleSignatories: [{}] }, { clientSignatories: Array(SIGNOFF_MAX_SIGNATORIES + 1).fill({ name: '', title: '' }) }]) assert.throws(() => validateSignoff({ ...goLiveInput(), ...patch }))
  assert.equal(validateSignoff({ ...goLiveInput(), sections: { known_issues: '' } }).known_issues, '')
})

test('four images are embedded in order with independent relationships and escaped captions', async () => {
  const attachments = [image(), { name: 'photo.jpg', data: jpg.toString('base64'), caption: 'Photo' }, image('third.png'), image('fourth.png')]
  const result = await renderSignoff(template, input(), attachments)
  assert.equal(result.imageCount, 4); assert(result.fileName.endsWith('.docx'))
  const zip = new PizZip(result.output), doc = zip.file('word/document.xml')!.asText(), rels = zip.file('word/_rels/document.xml.rels')!.asText()
  for (let i = 1; i <= 4; i++) { assert(doc.includes(`rIdSignoffImage${i}`)); assert(rels.includes(`Id="rIdSignoffImage${i}"`)) }
  assert.deepEqual(zip.file('word/media/signoff-2.jpg')!.asNodeBuffer(), jpg)
  assert(doc.includes('Sample &amp; verified'))
  assert(doc.indexOf('Attachment 1') < doc.indexOf('Attachment 4'))
  const independent = new PizZip((await renderSignoff(template, { ...input(), clientName: 'Another Account' }, [])).output)
  assert(!independent.file('word/document.xml')!.asText().includes('rIdSignoffImage'))
})

test('supporting files are bundled byte-for-byte beside the Word form with safe unique paths', async () => {
  const bytes = Buffer.from('Supporting evidence — keep original bytes')
  const result = await renderSignoff(template, input(), [image(), { name: '../../report.txt', data: bytes.toString('base64'), caption: 'Reference' }, { name: '../../report.txt', data: bytes.toString('base64'), caption: '' }])
  assert.equal(result.mimeType, 'application/zip')
  const zip = new PizZip(result.output), paths = Object.keys(zip.files).filter(p => !zip.files[p].dir)
  assert.equal(paths.length, 4)
  assert(paths.every(p => !p.split('/').includes('..')))
  for (const path of paths.filter(p => p.endsWith('.txt'))) assert.deepEqual(zip.file(path)!.asNodeBuffer(), bytes)
  const doc = new PizZip(zip.file(paths.find(p => p.endsWith('.docx'))!)!.asNodeBuffer())
  assert(doc.file('word/document.xml')!.asText().includes('accompanying ZIP'))
})

test('custom filename follows the Word form into the downloadable ZIP and DocHub upload', async () => {
  const stem = 'SO-Example-Branch-7'
  const word = await renderSignoff(template, input(), [], `${stem}.docx`)
  assert.equal(word.fileName, `${stem}.docx`)
  const packaged = await renderSignoff(template, input(), [{ name: 'approval.txt', data: Buffer.from('approved').toString('base64'), caption: '' }], `${stem}.docx`)
  assert.equal(packaged.fileName, `${stem}.zip`)
  assert.equal(packaged.signingFile?.fileName, `${stem}.docx`)
  assert(new PizZip(packaged.output).file(`${stem}.docx`))
})

test('attachment validation rejects unsupported files, malformed images, oversized uploads, and excess counts', async () => {
  for (const attachments of [[{ name: 'run.exe', data: 'eA==', caption: '' }], [{ name: 'bad.png', data: 'eA==', caption: '' }], [{ name: 'bad.txt', data: '====', caption: '' }], Array.from({ length: 21 }, () => image()), [{ name: 'big.txt', data: Buffer.alloc(SIGNOFF_MAX_FILE_BYTES + 1).toString('base64'), caption: '' }]]) await assert.rejects(() => renderSignoff(template, input(), attachments))
  const validLargeText = { name: 'large.txt', data: Buffer.alloc(4 * 1024 * 1024, 65).toString('base64'), caption: '' }
  await assert.rejects(() => renderSignoff(template, input(), [validLargeText, validLargeText, validLargeText, { name: 'one.txt', data: 'eA==', caption: '' }]), /12 MB/)
})

test('HTTP generation requires a tenant with document write access and needs no AI credentials', async () => {
  const app = express(); app.use(express.json())
  const auth: any = (req: any, res: any, next: any) => {
    const role = req.get('x-test-role'); if (!role) return res.sendStatus(401)
    req.authUser = { role: role === 'Viewer' ? 'Viewer' : role === 'Contributor' ? 'Contributor' : 'Administrator', accountType: role === 'platform' ? 'platform' : 'tenant', organizationId: req.get('x-test-tenant') || 'a', modules: role === 'no-documents' ? [] : ['documents'] }; next()
  }
  const tenant: any = (req: any, res: any, next: any) => req.authUser.accountType === 'tenant' ? next() : res.sendStatus(403)
  const queried: { tenant: string; kind: string }[] = [], rows = new Map<string, any>()
  const db: any = { from: () => {
    const filters: Record<string, string> = {}
    const query: any = { select: () => query, eq: (key: string, value: string) => { filters[key] = value; return query }, maybeSingle: async () => {
      queried.push({ tenant: filters.tenant_id, kind: filters.template_type })
      return { data: rows.get(`${filters.tenant_id}:${filters.template_type}`) || null, error: null }
    } }; return query
  } }
  registerSignoffRoutes(app, { db, requireAuth: auth, requireTenant: tenant, templatePath, goLiveTemplatePath })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const call = (role: string, tenantId = 'a', details: any = input()) => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/documents/signoff/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role, 'x-test-tenant': tenantId }, body: JSON.stringify({ details: { ...details, clientName: tenantId }, attachments: [] }) })
    assert.equal((await call('')).status, 401)
    for (const role of ['Viewer', 'platform', 'no-documents']) assert.equal((await call(role)).status, 403)
    for (const role of ['Administrator', 'Contributor']) {
      const response = await call(role); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const result = await response.json(); assert(result.fileName.endsWith('.docx'))
    }
    const result = await (await call('Contributor', 'second-tenant')).json()
    assert(result.fileName.includes('SECONDTENANT'))
    const liveResponse = await call('Contributor', 'second-tenant', goLiveInput()); assert.equal(liveResponse.status, 200)
    const liveResult = await liveResponse.json(); assert(liveResult.fileName.startsWith('SOF-SECONDTENANT'))
    assert.deepEqual(queried.at(-1), { tenant: 'second-tenant', kind: 'golive' })
    rows.set('second-tenant:golive', { is_enabled: false })
    assert.equal((await call('Contributor', 'second-tenant', goLiveInput())).status, 503)
    assert.equal((await call('Contributor', 'second-tenant')).status, 200)
    assert.equal((await call('Contributor', 'a', goLiveInput())).status, 200)
    assert.equal((await call('Contributor', 'a', { ...input(), formType: 'unsupported' })).status, 400)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
