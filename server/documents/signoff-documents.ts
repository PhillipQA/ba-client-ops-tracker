import { readFile } from 'node:fs/promises'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { PDFDocument } from 'pdf-lib'
import type { Express, RequestHandler } from 'express'
import { documentTemplateRow, IntegrationError } from '../integrations/tenant-integrations'
import { DEPLOYMENT_TYPES, DEPLOYED_PRODUCTS, SIGNOFF_MAX_ATTACHMENTS, SIGNOFF_MAX_FILE_BYTES, SIGNOFF_MAX_TOTAL_BYTES, formatDeploymentDate, signoffReference } from '../../src/signoff'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const supported = new Set(['png', 'jpg', 'jpeg', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'zip'])
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!))
function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Invalid ${label}.`)
  const result = value.trim()
  if (required && !result) throw new Error(`${label} is required.`)
  return result
}
export function validateSignoff(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Sign Off details are required.')
  const clientName = text(input.clientName, 'Client name', 150)
  const site = text(input.site, 'Site code / name', 160)
  const deploymentDate = formatDeploymentDate(text(input.deploymentDate, 'Deployment date', 10))
  if (!(DEPLOYMENT_TYPES as readonly unknown[]).includes(input.deploymentType)) throw new Error('Choose a supported deployment type.')
  if (!(DEPLOYED_PRODUCTS as readonly unknown[]).includes(input.product)) throw new Error('Choose a supported product.')
  const year = text(input.documentYear, 'Document year', 4)
  const number = text(input.documentNumber, 'Document number', 4)
  if (!/^(19|[2-9]\d)\d{2}$/.test(year) || !/^\d{1,4}$/.test(number) || Number(number) < 1) throw new Error('Enter a valid document year and a number from 1 to 9999.')
  const values: Record<string, string> = { client_name: clientName, document_reference: signoffReference(clientName, year, String(Number(number))), deployment_date: deploymentDate, deployment_type: input.deploymentType, product: input.product, site }
  for (const [side, key] of [['iripple', 'irippleSignatories'], ['client', 'clientSignatories']]) {
    const people = input[key]
    if (!Array.isArray(people) || people.length !== 3) throw new Error('Provide three signatories for iRipple and three for the client.')
    people.forEach((person, index) => {
      values[`${side}_name_${index + 1}`] = text(person?.name, `${side} signatory ${index + 1} name`, 100, false)
      values[`${side}_title_${index + 1}`] = text(person?.title, `${side} signatory ${index + 1} position`, 100, false)
    })
  }
  return values
}
function imageSize(bytes: Buffer, ext: string) {
  if (ext === 'png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG attachment.')
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Invalid JPEG attachment.')
  let position = 2
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 255) break
    while (bytes[position] === 255) position++
    const marker = bytes[position++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (position + 2 > bytes.length) break
    const length = bytes.readUInt16BE(position)
    if (length < 2 || position + length > bytes.length) break
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { height: bytes.readUInt16BE(position + 3), width: bytes.readUInt16BE(position + 5) }
    position += length
  }
  throw new Error('Unsupported or damaged JPEG. Export it as PNG and retry.')
}
function para(value: string, pageBreak = false) {
  return `<w:p><w:pPr>${pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`
}
function imageParagraph(id: string, name: string, width: number, height: number, index: number) {
  const scale = Math.min(5.9 / width, 6.5 / height)
  const cx = Math.round(width * scale * 914400), cy = Math.round(height * scale * 914400)
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${1000 + index}" name="Attachment ${index}" descr="${xml(name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${1000 + index}" name="${xml(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}
export async function renderSignoff(template: Buffer, input: unknown, attachments: unknown = []) {
  const values = validateSignoff(input)
  if (!Array.isArray(attachments) || attachments.length > SIGNOFF_MAX_ATTACHMENTS) throw new Error(`Use up to ${SIGNOFF_MAX_ATTACHMENTS} attachments.`)
  const zip = new PizZip(template)
  // Keep long client-derived references readable inside the original header cell.
  if (values.document_reference.length > 55) {
    for (const part of zip.file(/^word\/header\d+\.xml$/)) {
      zip.file(part.name, part.asText().replace(/<w:r[ >][\s\S]*?<\/w:r>/g, run => run.includes('{document_reference}') ? run.replace(/<w:sz w:val="\d+"\/>/g, '<w:sz w:val="16"/>') : run))
    }
  }
  const files: { name: string; bytes: Buffer; image: boolean; caption: string; width?: number; height?: number; ext: string }[] = []
  let totalBytes = 0, totalPixels = 0
  for (const item of attachments) {
    const originalName = text(item?.name, 'Attachment filename', 200)
    const ext = originalName.split('.').pop()!.toLowerCase()
    if (!supported.has(ext)) throw new Error(`Unsupported attachment format: ${ext}.`)
    const data = item?.data
    if (typeof data !== 'string' || data.length > Math.ceil(SIGNOFF_MAX_FILE_BYTES / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) throw new Error('Invalid attachment data or file exceeds 5 MB.')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data) throw new Error('Invalid base64 attachment data.')
    totalBytes += bytes.length
    if (!bytes.length || bytes.length > SIGNOFF_MAX_FILE_BYTES || totalBytes > SIGNOFF_MAX_TOTAL_BYTES) throw new Error('Use files up to 5 MB each and 12 MB in total.')
    const name = originalName.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '') || `attachment.${ext}`
    const caption = text(item.caption ?? '', 'Attachment caption', 200, false)
    const image = ['png', 'jpg', 'jpeg'].includes(ext)
    let dimensions: { width: number; height: number } | undefined
    if (image) {
      dimensions = imageSize(bytes, ext)
      const pixels = dimensions.width * dimensions.height
      totalPixels += pixels
      if (!pixels || pixels > 16000000 || totalPixels > 40000000) throw new Error('Images are too large. Resize images to at most 16 megapixels each and 40 megapixels total.')
      // Decode accepted formats once to reject corrupt image bytes before exporting Word.
      try { const check = await PDFDocument.create(); const img = ext === 'png' ? await check.embedPng(bytes) : await check.embedJpg(bytes); if (!img.width || !img.height) throw new Error() }
      catch { throw new Error('An image attachment is damaged. Export it as JPEG or PNG and retry.') }
    }
    files.push({ name, bytes, image, caption, ext, ...dimensions })
  }
  let relationships = zip.file('word/_rels/document.xml.rels')!.asText()
  let contentTypes = zip.file('[Content_Types].xml')!.asText()
  let attachmentXml = ''
  if (files.some(file => !file.image)) {
    attachmentXml += para('Supporting files')
    attachmentXml += para('The following files are included in the accompanying ZIP:')
    files.forEach((file, index) => { if (!file.image) attachmentXml += para(`${index + 1}. ${file.name}${file.caption ? ` — ${file.caption}` : ''}`) })
  }
  files.forEach((file, index) => {
    if (!file.image) return
    const id = `rIdSignoffImage${index + 1}`, target = `media/signoff-${index + 1}.${file.ext}`
    zip.file(`word/${target}`, file.bytes)
    relationships = relationships.replace('</Relationships>', `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`)
    contentTypes = contentTypes.replace('</Types>', `<Override PartName="/word/${target}" ContentType="image/${file.ext === 'png' ? 'png' : 'jpeg'}"/></Types>`)
    attachmentXml += para(`Attachment ${index + 1} — ${file.caption || file.name}`, true)
    attachmentXml += imageParagraph(id, file.name, file.width!, file.height!, index + 1)
  })
  zip.file('word/_rels/document.xml.rels', relationships); zip.file('[Content_Types].xml', contentTypes)
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' })
  doc.render({ ...values, attachments: attachmentXml })
  const output = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
  const stem = values.document_reference.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180)
  if (files.some(file => !file.image)) {
    const bundle = new PizZip(); bundle.file(`${stem}.docx`, output)
    files.forEach((file, index) => bundle.file(`attachments/${String(index + 1).padStart(2, '0')}-${file.name}`, file.bytes))
    return { signingFile: { fileData: output.toString('base64'), fileName: `${stem}.docx`, mimeType: DOCX_MIME }, output: bundle.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), fileName: `${stem}.zip`, mimeType: 'application/zip', imageCount: files.filter(f => f.image).length, attachmentCount: files.length }
  }
  return { output, fileName: `${stem}.docx`, mimeType: DOCX_MIME, imageCount: files.length, attachmentCount: files.length }
}
export function registerSignoffRoutes(app: Express, deps: { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; templatePath: string }) {
  app.post('/api/documents/signoff/generate', deps.requireAuth, deps.requireTenant, async (req, res) => {
    const user = (req as any).authUser
    if (user.role === 'Viewer' || !user.modules?.includes('documents')) return void res.status(403).json({ error: 'Document Creation access with write permission is required.' })
    res.setHeader('Cache-Control', 'no-store')
    let template: Buffer
    try {
      const row = await documentTemplateRow(deps.db, user.organizationId, 'signoff')
      if (row && !row.is_enabled) throw new IntegrationError('The Sign Off template is not configured. Add or restore it in Settings → Templates.', 503)
      template = row?.is_enabled && row.content_base64 ? Buffer.from(row.content_base64, 'base64') : await readFile(deps.templatePath)
    } catch (error) {
      return void res.status(error instanceof IntegrationError ? error.status : 503).json({ error: error instanceof Error ? error.message : 'Sign Off template is unavailable.' })
    }
    try {
      const result = await renderSignoff(template, req.body?.details, req.body?.attachments)
      res.json({ signingFile: result.signingFile, fileData: result.output.toString('base64'), fileName: result.fileName, mimeType: result.mimeType, imageCount: result.imageCount, attachmentCount: result.attachmentCount })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Could not generate the Sign Off form.' }) }
  })
}
