import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import PizZip from 'pizzip'
import { renderSignoff, registerSignoffRoutes, validateSignoff } from '../server/documents/signoff-documents'
import { DEPLOYMENT_TYPES, DEPLOYED_PRODUCTS, SIGNOFF_PURPOSE, SIGNOFF_MAX_FILE_BYTES, formatDeploymentDate } from '../src/signoff'

const templatePath = new URL('../templates/signoff-template.docx', import.meta.url).pathname
const template = await readFile(templatePath)
const png = await readFile(new URL('./fixtures/signoff-evidence.png', import.meta.url))
const jpg = await readFile(new URL('./fixtures/signoff-evidence.jpg', import.meta.url))
const input = () => ({ clientName: 'Example & Partners <Retail>', deploymentDate: '2026-09-25', deploymentType: 'Production - Branch', product: 'Barter CX v1.0', site: 'BR-001 & Main', documentYear: '2026', documentNumber: '7', irippleSignatories: [1, 2, 3].map(i => ({ name: `iRipple Person ${i}`, title: `iRipple Role ${i}` })), clientSignatories: [1, 2, 3].map(i => ({ name: `Client Person ${i}`, title: `Client Role ${i}` })) })
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
  registerSignoffRoutes(app, { requireAuth: auth, requireTenant: tenant, templatePath })
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const call = (role: string, tenantId = 'a') => fetch(`http://127.0.0.1:${(server.address() as any).port}/api/documents/signoff/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role, 'x-test-tenant': tenantId }, body: JSON.stringify({ details: { ...input(), clientName: tenantId }, attachments: [] }) })
    assert.equal((await call('')).status, 401)
    for (const role of ['Viewer', 'platform', 'no-documents']) assert.equal((await call(role)).status, 403)
    for (const role of ['Administrator', 'Contributor']) {
      const response = await call(role); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const result = await response.json(); assert(result.fileName.endsWith('.docx'))
    }
    const result = await (await call('Contributor', 'second-tenant')).json()
    assert(result.fileName.includes('SECONDTENANT'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
