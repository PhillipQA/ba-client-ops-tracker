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
      for (const name of parts) {
        const content = zip.file(name)!.asText()
        if (content.length > 5000000) throw new Error(`${file.name}: document is too large to extract.`)
        const xml = new DOMParser().parseFromString(content,'application/xml')
        if (xml.querySelector('parsererror')) throw new Error(`${file.name}: damaged Word document.`)
        extracted.push(`[${name.replace('word/','')}]\n${wordText(xml.documentElement)}`)
        check(extracted.join('\n'))
      }
      const media = Object.keys(zip.files).filter(name => name.startsWith('word/media/') && !zip.files[name].dir)
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
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
      try {
        if (pdf.numPages > 80) throw new Error(`${file.name}: split PDFs longer than 80 pages before uploading.`)
        const pages: string[] = []
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
              const initial = page.getViewport({ scale: 1 }), scale = Math.min(2, 2200 / Math.max(initial.width,initial.height))
              const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas')
              canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
              try {
                await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
                const recognized = await ocr(canvas, `${file.name}, page ${pageNo} of ${pdf.numPages}`)
                // Keep native text as evidence even if OCR disagrees or misses small text.
                pageText = `${embedded ? `[Selectable text]\n${embedded}\n` : ''}[OCR text]\n${recognized}`
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
