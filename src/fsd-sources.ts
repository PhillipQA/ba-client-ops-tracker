import PizZip from 'pizzip'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
const LIMIT = 120000
const IMAGE_EXTENSIONS = new Set(['png','jpg','jpeg','webp','bmp','tif','tiff'])
export function isFsdImageFile(file: { name: string }) { return IMAGE_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() || '') }

/** Preserve paragraph, hard-break and table boundaries in Word source text. */
export function wordText(node: Node): string {
  if (node.nodeType !== 1) return ''
  const element = node as Element, name = element.localName
  if (name === 't') return element.textContent || ''
  if (name === 'br' || name === 'cr') return '\n'
  if (name === 'tab') return '\t'
  const content = Array.from(node.childNodes).map(wordText).join('')
  if (name === 'tc') return content.trim().replace(/\n/g, ' / ') + ' | '
  if (name === 'tr') return '| ' + content.replace(/ \| $/, ' |') + '\n'
  if (name === 'p' || name === 'tbl') return content + '\n'
  return content
}

/** PDF images may contain the body even when headers/footers are selectable. */
export function pdfNeedsOcr(text: string, hasImages: boolean) { return hasImages || text.trim().length < 20 }

/** Only OCR pictures placed in the document body. Template logos and footer art
 * are packaged as media too, but they are not requirement evidence. */
function bodyImageParts(zip: PizZip, documentXml: Document): string[] {
  const rels = zip.file('word/_rels/document.xml.rels')
  if (!rels) return []
  const relationships = new DOMParser().parseFromString(rels.asText(), 'application/xml')
  if (relationships.querySelector('parsererror')) return []
  const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const usedIds = new Set<string>()
  for (const element of Array.from(documentXml.getElementsByTagName('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === relationshipNs) usedIds.add(attribute.value)
    }
  }
  const parts: string[] = []
  for (const relationship of Array.from(relationships.getElementsByTagName('*'))) {
    if (relationship.localName !== 'Relationship' || !usedIds.has(relationship.getAttribute('Id') || '') ||
        !relationship.getAttribute('Type')?.endsWith('/image') || relationship.getAttribute('TargetMode') === 'External') continue
    const target = relationship.getAttribute('Target') || ''
    const segments: string[] = []
    for (const segment of (target.startsWith('/') ? target.slice(1) : `word/${target}`).split('/')) {
      if (segment === '..') segments.pop()
      else if (segment && segment !== '.') segments.push(segment)
    }
    const name = segments.join('/')
    if (name.startsWith('word/media/') && zip.file(name) && !parts.includes(name)) parts.push(name)
  }
  return parts
}
export async function readFsdSource(file: File, progress: (message: string) => void): Promise<string> {
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: use a nonempty file up to 10 MB.`)
  const ext = file.name.split('.').pop()?.toLowerCase()
  let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | undefined
  const ocr = async (source: File | Blob | HTMLCanvasElement, label: string) => {
    progress(`Reading ${label} with OCR…`)
    if (!worker) { const { createWorker } = await import('tesseract.js'); worker = await createWorker('eng') }
    const result = (await worker.recognize(source)).data
    const warning = result.confidence < 75 ? `[Extraction warning: OCR confidence ${Math.round(result.confidence)}%. Verify this text against the original.]\n` : ''
    if (!result.text.trim()) return '[Extraction warning: no readable text found in this image; inspect the original for visual requirements.]'
    return warning + result.text
  }
  const check = (text: string) => { if (text.length > LIMIT) throw new Error(`${file.name}: extracted text exceeds 120,000 characters. Split the document; no text has been truncated.`); return text }
  let text = ''
  try {
    if (IMAGE_EXTENSIONS.has(ext || '')) {
      text = '[Extraction warning: OCR reads English text; review visual layout, diagrams and other languages in the original.]\n' + await ocr(file, file.name)
    } else if (['txt','md','csv','json'].includes(ext || '')) text = await file.text()
    else if (ext === 'docx') {
      const zip = new PizZip(await file.arrayBuffer())
      if (!zip.file('word/document.xml')) throw new Error(`${file.name}: invalid Word document.`)
      const parts = ['word/document.xml', ...Object.keys(zip.files).filter(name => /^word\/(header|footer|footnotes|endnotes).*\.xml$/.test(name)).sort()]
      const extracted: string[] = []
      let bodyXml: Document | undefined
      for (const name of parts) {
        const content = zip.file(name)!.asText()
        if (content.length > 5000000) throw new Error(`${file.name}: document is too large to extract.`)
        const xml = new DOMParser().parseFromString(content,'application/xml')
        if (xml.querySelector('parsererror')) throw new Error(`${file.name}: damaged Word document.`)
        if (name === 'word/document.xml') bodyXml = xml
        extracted.push(`[${name.replace('word/','')}]\n${wordText(xml.documentElement)}`)
        check(extracted.join('\n'))
      }
      const media = bodyXml ? bodyImageParts(zip, bodyXml) : []
      for (const name of media) {
        if (!isFsdImageFile({name})) { extracted.push(`[Extraction warning: review unsupported embedded visual ${name} in the original.]`); continue }
        const bytes = zip.file(name)!.asUint8Array()
        if (bytes.length > 10 * 1024 * 1024) throw new Error(`${file.name}: embedded image is too large for OCR.`)
        extracted.push(`[Embedded image: ${name}; review its position and diagrams in the original]\n${await ocr(new Blob([new Uint8Array(bytes)]), name)}`)
        check(extracted.join('\n'))
      }
      if (media.length || Object.keys(zip.files).some(name => /^word\/(charts|diagrams)\//.test(name))) extracted.unshift('[Extraction warning: this Word document contains visuals. OCR text is included where supported; review image placement, charts and relationships in the original.]')
      text = extracted.join('\n\n')
    } else if (ext === 'pdf') {
      const pdfjs = await import('pdfjs-dist').catch(()=>{throw new Error('The PDF reader could not load. Save any unsaved inputs, refresh this page, then select the PDF again. If it still fails, check the deployed app assets.')})
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
      try {
        if (pdf.numPages > 80) throw new Error(`${file.name}: split PDFs longer than 80 pages before uploading.`)
        const pages: string[] = []
        let imageCount = 0
        const seenImageText = new Map<string, number>()
        const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup])
        for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
          progress(`Reading ${file.name}: page ${pageNo} of ${pdf.numPages}…`)
          const page = await pdf.getPage(pageNo)
          try {
            const content = await page.getTextContent(), operators = await page.getOperatorList()
            const embedded = content.items.map(item => 'str' in item ? item.str + (item.hasEOL?'\n':' ') : '').join('').trim()
            const hasImages = operators.fnArray.some(op => imageOps.has(op))
            let pageText = embedded
            if (pdfNeedsOcr(embedded, hasImages)) {
              // Capture PDF.js's decoded image bitmaps while the page renders. Once
              // rendering finishes PDF.js may release them from its object cache.
              // Reading the whole page alone makes small report screenshots illegible.
              const names = [...new Set(operators.fnArray.flatMap((op, index) =>
                op === pdfjs.OPS.paintImageXObject && typeof operators.argsArray[index]?.[0] === 'string'
                  ? [operators.argsArray[index][0] as string] : []))]
              const otherImageOps = operators.fnArray.some(op => imageOps.has(op) && op !== pdfjs.OPS.paintImageXObject)
              imageCount += names.length
              if (imageCount > 80 || names.length > 12) throw new Error(`${file.name}: too many embedded images for one source. Split this PDF into smaller parts.`)
              const captured = names.map(name => new Promise<{ name: string, canvas?: HTMLCanvasElement }>(resolve => {
                const objects = name.startsWith('g_') ? page.commonObjs : page.objs
                objects.get(name, (image: { bitmap?: ImageBitmap, width?: number, height?: number }) => {
                  if (!image?.bitmap || !image.width || !image.height || image.width * image.height > 16_000_000)
                    return resolve({ name })
                  try {
                    const canvas = document.createElement('canvas')
                    const scale = Math.min(2, 2400 / Math.max(image.width, image.height))
                    canvas.width = Math.ceil(image.width * scale); canvas.height = Math.ceil(image.height * scale)
                    canvas.getContext('2d')!.drawImage(image.bitmap, 0, 0, canvas.width, canvas.height)
                    resolve({ name, canvas })
                  } catch { resolve({ name }) } // Fall back to page OCR if PDF.js cannot expose the bitmap.
                })
              }))
              const initial = page.getViewport({ scale: 1 }), scale = Math.min(2, 2200 / Math.max(initial.width,initial.height))
              const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas')
              canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
              try {
                await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
                const images = captured.length ? await Promise.race([
                  Promise.all(captured),
                  new Promise<null>(resolve => setTimeout(() => resolve(null), 1500)),
                ]) : []
                const imageText: string[] = []
                if (images) for (const image of images) {
                  if (!image.canvas) continue
                  try {
                    const recognized = await ocr(image.canvas, `${file.name}, page ${pageNo}, image ${image.name}`)
                    const duplicate = seenImageText.get(recognized)
                    if (duplicate) imageText.push(`[Embedded image: page ${pageNo}, ${image.name}; same text as page ${duplicate}]`)
                    else {
                      seenImageText.set(recognized, pageNo)
                      imageText.push(`[Embedded image: page ${pageNo}, ${image.name}; verify layout and numeric values against the original]\n${recognized}`)
                    }
                  } finally { image.canvas.width = 0; image.canvas.height = 0 }
                }
                // A full-page pass remains the fallback for vector drawings, inline
                // images and PDF.js image objects that could not be captured.
                if (!imageText.length || !embedded || imageText.length < names.length || otherImageOps) {
                  const recognized = await ocr(canvas, `${file.name}, page ${pageNo} of ${pdf.numPages}`)
                  pageText = `${embedded ? `[Selectable text]\n${embedded}\n` : ''}[OCR text]\n${recognized}`
                } else pageText = `${embedded ? `[Selectable text]\n${embedded}\n\n` : ''}${imageText.join('\n\n')}`
                // When some images cannot be decoded, the page pass preserves their text.
                if (imageText.length && pageText.includes('[OCR text]')) pageText += '\n\n' + imageText.join('\n\n')
              } finally { canvas.width = 0; canvas.height = 0 }
            }
            if (hasImages) pageText = '[Extraction warning: page contains images. OCR reads text only; review diagrams and layout in the original.]\n' + pageText
            pages.push(`[Page ${pageNo}]\n${pageText || '[No readable text; review the original page.]'}`)
            check(pages.join('\n\n'))
          } finally { page.cleanup() }
        }
        text = pages.join('\n\n')
      } finally { await pdf.destroy() }
    } else throw new Error(`${file.name}: use PDF, DOCX, TXT, MD, CSV, JSON or a supported image. Convert older DOC files to DOCX first.`)
    text = text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim()
    if (!text) throw new Error(`${file.name}: no readable text was detected.`)
    return check(text)
  } finally { await worker?.terminate() }
}
