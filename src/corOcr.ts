import PizZip from 'pizzip'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

type ProgressCallback = (message: string) => void

export type LocalCorExtraction = {
  businessName: string
  tradeName: string
  tin: string
  address: string
  notes: string
}

const MAX_PDF_OCR_PAGES = 4
const MIN_TEXT_PDF_CHARS = 140

function normalizeWhitespace(value: string) {
  return value.replace(/\r/g, '\n').replace(/[\t\f\v]+/g, ' ').replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
}

function extractDocxText(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const zip = new PizZip(buffer)
    const documentXml = zip.file('word/document.xml')?.asText()
    if (!documentXml) throw new Error('The DOCX file does not contain readable document text.')
    const text = documentXml
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
    return normalizeWhitespace(decodeXmlEntities(text))
  })
}

async function createOcrWorker() {
  const { createWorker } = await import('tesseract.js')
  return createWorker('eng')
}

async function recognizeWithWorker(worker: any, source: Blob | File | HTMLCanvasElement) {
  const result = await worker.recognize(source)
  return normalizeWhitespace(String(result?.data?.text || ''))
}

async function extractImageText(file: File, onProgress?: ProgressCallback) {
  onProgress?.('Running local OCR in your browser…')
  const worker = await createOcrWorker()
  try {
    return await recognizeWithWorker(worker, file)
  } finally {
    await worker.terminate()
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare the PDF page for OCR.')), 'image/png')
  })
}

async function extractPdfText(file: File, onProgress?: ProgressCallback) {
  onProgress?.('Checking the PDF for embedded text…')
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  const pageLimit = Math.min(pdf.numPages, MAX_PDF_OCR_PAGES)
  const embeddedPages: string[] = []

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    let pageText = ''
    for (const item of content.items as any[]) {
      if (typeof item?.str !== 'string' || !item.str) continue
      pageText += item.str
      pageText += item.hasEOL ? '\n' : ' '
    }
    if (pageText.trim()) embeddedPages.push(pageText)
  }

  const embeddedText = normalizeWhitespace(embeddedPages.join('\n'))
  if (embeddedText.replace(/\s/g, '').length >= MIN_TEXT_PDF_CHARS) {
    return { text: embeddedText, method: 'embedded PDF text' }
  }

  onProgress?.(`The PDF appears scanned. Running local OCR on up to ${pageLimit} page${pageLimit === 1 ? '' : 's'}…`)
  const worker = await createOcrWorker()
  const ocrPages: string[] = []
  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      onProgress?.(`Running local OCR on PDF page ${pageNumber} of ${pageLimit}…`)
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1.8 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Your browser could not create the OCR canvas.')
      await page.render({ canvas, canvasContext: context, viewport }).promise
      const blob = await canvasToBlob(canvas)
      const pageText = await recognizeWithWorker(worker, blob)
      if (pageText) ocrPages.push(pageText)
    }
  } finally {
    await worker.terminate()
  }

  const text = normalizeWhitespace([embeddedText, ...ocrPages].filter(Boolean).join('\n'))
  return { text, method: 'local OCR' }
}

function lineKey(value: string) {
  return value
    .toUpperCase()
    .replace(/[|]/g, 'I')
    .replace(/[^A-Z0-9/:()&\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const knownLabelPatterns = [
  /TRADE\s*(?:\/|OR)?\s*BUSINESS\s*NAME/,
  /TRADE\s*NAME/,
  /REGISTERED\s*(?:BUSINESS\s*)?NAME/,
  /NAME\s*OF\s*TAXPAYER/,
  /TAXPAYER\s*NAME/,
  /TAXPAYER\s*IDENTIFICATION\s*NUMBER/,
  /\bTIN\b/,
  /REGISTERED\s*(?:BUSINESS\s*)?ADDRESS/,
  /BUSINESS\s*ADDRESS/,
  /REGISTERED\s*ADDRESS\s*OF\s*TAXPAYER/,
  /REGISTERED\s*ACTIVITY/,
  /LINE\s*OF\s*BUSINESS/,
  /BUSINESS\s*STYLE/,
  /REGISTRATION\s*DATE/,
  /CERTIFICATE\s*OF\s*REGISTRATION/,
  /RDO\s*CODE/,
  /TAX\s*TYPE/,
]

function isKnownLabel(line: string) {
  const normalized = lineKey(line)
  return knownLabelPatterns.some((pattern) => pattern.test(normalized))
}

function valueAfterInlineLabel(line: string) {
  const colon = line.indexOf(':')
  if (colon >= 0 && colon < line.length - 1) return line.slice(colon + 1).trim()
  return ''
}

function collectAfterLabel(lines: string[], labelPatterns: RegExp[], maxLines = 2) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const normalized = lineKey(line)
    if (!labelPatterns.some((pattern) => pattern.test(normalized))) continue

    const inline = valueAfterInlineLabel(line)
    if (inline && !isKnownLabel(inline)) return inline

    const collected: string[] = []
    for (let offset = 1; offset <= maxLines && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset].trim()
      if (!candidate) continue
      if (isKnownLabel(candidate)) break
      collected.push(candidate)
    }
    if (collected.length) return collected.join(' ').trim()
  }
  return ''
}

function findTin(text: string, lines: string[]) {
  const tinLabelLine = lines.find((line) => /\bTIN\b|TAXPAYER\s*IDENTIFICATION\s*NUMBER/i.test(line))
  const candidates = [tinLabelLine || '', text]
  for (const candidate of candidates) {
    const match = candidate.match(/\b\d{3}\s*[-–— ]\s*\d{3}\s*[-–— ]\s*\d{3}(?:\s*[-–— ]\s*\d{3,5})?\b/)
    if (match) return match[0].replace(/\s*[-–— ]\s*/g, '-').trim()
  }
  return ''
}

function cleanExtractedValue(value: string) {
  return value
    .replace(/^[\s:;.,\-–—]+/, '')
    .replace(/[\s:;.,\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCorText(rawText: string, method: string): LocalCorExtraction {
  const text = normalizeWhitespace(rawText)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)

  const tradeName = cleanExtractedValue(collectAfterLabel(lines, [
    /TRADE\s*(?:\/|OR)?\s*BUSINESS\s*NAME/,
    /TRADE\s*NAME/,
    /BUSINESS\s*STYLE/,
  ], 2))

  const businessName = cleanExtractedValue(collectAfterLabel(lines, [
    /REGISTERED\s*(?:BUSINESS\s*)?NAME/,
    /NAME\s*OF\s*TAXPAYER/,
    /TAXPAYER\s*NAME/,
  ], 2))

  const address = cleanExtractedValue(collectAfterLabel(lines, [
    /REGISTERED\s*(?:BUSINESS\s*)?ADDRESS/,
    /REGISTERED\s*ADDRESS\s*OF\s*TAXPAYER/,
    /BUSINESS\s*ADDRESS/,
  ], 4))

  const tin = cleanExtractedValue(findTin(text, lines))
  const missing = [
    !businessName && 'Business Name',
    !tradeName && 'Trade Name',
    !tin && 'TIN',
    !address && 'Address',
  ].filter(Boolean)

  const notes = missing.length
    ? `Processed using ${method}. Could not confidently detect: ${missing.join(', ')}. Please fill or correct those fields manually.`
    : `Processed using ${method}. Please review the extracted values before generating the DRF.`

  return { businessName, tradeName, tin, address, notes }
}

export async function extractCorLocally(file: File, onProgress?: ProgressCallback): Promise<LocalCorExtraction> {
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  const mimeType = file.type.toLowerCase()
  let text = ''
  let method = 'local OCR'

  if (extension === 'pdf' || mimeType === 'application/pdf') {
    const result = await extractPdfText(file, onProgress)
    text = result.text
    method = result.method
  } else if (extension === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    onProgress?.('Reading DOCX text locally in your browser…')
    text = await extractDocxText(file)
    method = 'local DOCX text extraction'
  } else if (extension === 'doc' || mimeType === 'application/msword') {
    throw new Error('Legacy .doc COR files are not supported by the private local extractor. Please save the COR as PDF, DOCX, JPEG, or PNG first.')
  } else {
    text = await extractImageText(file, onProgress)
    method = 'local OCR'
  }

  if (!text || text.replace(/\s/g, '').length < 20) {
    throw new Error('The local extractor could not read enough text from this COR. Try a clearer scan/photo or a text-based PDF.')
  }

  onProgress?.('Matching COR text to Business Name, Trade Name, TIN, and Address…')
  return parseCorText(text, method)
}
