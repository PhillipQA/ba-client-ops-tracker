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

const nameOfTaxpayerPatterns = [
  /NAME\s*(?:OF\s*(?:THE\s*)?)?TAX\s*PAYER/,
  /TAX\s*PAYER\s*NAME/,
]

const registeredNamePatterns = [
  /REGISTERED\s*(?:BUSINESS\s*)?NAME/,
  /BUSINESS\s*REGISTERED\s*NAME/,
]

const tradeNamePatterns = [
  /TRADE\s*(?:\/|OR|AND|&)\s*BUSINESS\s*NAME/,
  /BUSINESS\s*(?:\/|OR|AND|&)\s*TRADE\s*NAME/,
  /TRADE\s*NAME(?:\s*\(\s*IF\s*(?:APPLICABLE|ANY)\s*\))?/,
  /BUSINESS\s*STYLE/,
]

const addressLabelPatterns = [
  /REGISTERED\s*ADDRESS\s*OF\s*TAX\s*PAYER/,
  /REGISTERED\s*(?:BUSINESS\s*)?ADDRESS/,
  /BUSINESS\s*ADDRESS/,
  /TAX\s*PAYER\s*ADDRESS/,
]

const tinLabelPatterns = [
  /TAX\s*PAYER\s*IDENTIFICATION\s*NUMBER/,
  /IDENTIFICATION\s*NUMBER\s*\(\s*TIN\s*\)/,
  /\bTIN\b/,
]

const knownLabelPatterns = [
  ...nameOfTaxpayerPatterns,
  ...registeredNamePatterns,
  ...tradeNamePatterns,
  ...tinLabelPatterns,
  ...addressLabelPatterns,
  /ZIP\s*CODE/,
  /REGISTERED\s*ACTIVIT(?:Y|IES)/,
  /LINE\s*OF\s*BUSINESS/,
  /PRIMARY\s*ACTIVIT(?:Y|IES)/,
  /SECONDARY\s*ACTIVIT(?:Y|IES)/,
  /REGISTRATION\s*DATE/,
  /CERTIFICATE\s*OF\s*REGISTRATION/,
  /REVENUE\s*DISTRICT\s*OFFICE/,
  /RDO\s*CODE/,
  /PSIC/,
  /TAX\s*TYPE/,
  /TAX\s*TYPES/,
  /BOOKS?\s*OF\s*ACCOUNTS?/,
  /INVOICE|RECEIPT/,
]

function regexForRawLine(pattern: RegExp) {
  const flags = pattern.flags.includes('i') ? pattern.flags : `${pattern.flags}i`
  return new RegExp(pattern.source, flags.replace('g', ''))
}

function isKnownLabel(line: string) {
  const normalized = lineKey(line)
  return knownLabelPatterns.some((pattern) => pattern.test(normalized))
}

function stripTrailingKnownLabel(value: string) {
  let cutoff = value.length
  for (const pattern of knownLabelPatterns) {
    const match = regexForRawLine(pattern).exec(value)
    if (match && match.index > 0) cutoff = Math.min(cutoff, match.index)
  }
  return value.slice(0, cutoff).trim()
}

function valueAfterMatchedLabel(line: string, pattern: RegExp) {
  const match = regexForRawLine(pattern).exec(line)
  if (!match) return ''
  const remainder = line.slice(match.index + match[0].length)
    .replace(/^\s*(?:[:;|=]|[-–—]{1,3})\s*/, '')
    .replace(/^\s*\([^)]*\)\s*/, '')
    .trim()
  if (!remainder) return ''
  return stripTrailingKnownLabel(remainder)
}

function collectAfterLabelByPriority(lines: string[], labelPatterns: RegExp[], maxLines = 2) {
  for (const pattern of labelPatterns) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const normalized = lineKey(line)
      if (!pattern.test(normalized)) continue

      const inline = valueAfterMatchedLabel(line, pattern)
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
  }
  return ''
}

function findTin(text: string, lines: string[]) {
  const tinLabelLine = lines.find((line) => tinLabelPatterns.some((pattern) => pattern.test(lineKey(line))))
  const candidates = [tinLabelLine || '', text]
  for (const candidate of candidates) {
    const match = candidate.match(/\b\d{3}\s*[-–— ]\s*\d{3}\s*[-–— ]\s*\d{3}(?:\s*[-–— ]\s*\d{3,5})?\b/)
    if (match) return match[0].replace(/\s*[-–— ]\s*/g, '-').trim()
  }
  return ''
}

function looksLikeAddressContinuation(value: string) {
  const normalized = lineKey(value)
  if (!normalized || normalized.length < 2) return false
  if (/^(?:BIR|REPUBLIC OF THE PHILIPPINES|BUREAU OF INTERNAL REVENUE)$/.test(normalized)) return false
  if (/^(?:CERTIFICATE OF REGISTRATION|FORM\s*2303)/.test(normalized)) return false
  return true
}

function extractZipCode(line: string) {
  const normalized = lineKey(line)
  if (!/ZIP\s*CODE/.test(normalized)) return ''
  const match = line.match(/(?:ZIP\s*CODE)\s*(?:[:;|=]|[-–—])?\s*(\d{4,5})\b/i)
  return match?.[1] || ''
}

function collectRegisteredAddress(lines: string[]) {
  for (const pattern of addressLabelPatterns) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!pattern.test(lineKey(line))) continue

      const parts: string[] = []
      const inline = cleanExtractedValue(valueAfterMatchedLabel(line, pattern))
      if (inline && !isKnownLabel(inline)) parts.push(inline)

      for (let offset = 1; offset <= 7 && index + offset < lines.length; offset += 1) {
        const candidate = lines[index + offset].trim()
        if (!candidate) continue

        const zipCode = extractZipCode(candidate)
        if (zipCode) {
          if (parts.length && !parts.join(' ').includes(zipCode)) parts.push(zipCode)
          continue
        }

        if (isKnownLabel(candidate)) break
        if (!looksLikeAddressContinuation(candidate)) continue

        const cleaned = cleanExtractedValue(candidate)
        if (!cleaned) continue
        if (!parts.some((part) => lineKey(part) === lineKey(cleaned))) parts.push(cleaned)
      }

      if (parts.length) {
        return parts
          .join(', ')
          .replace(/\s+,/g, ',')
          .replace(/,{2,}/g, ',')
          .replace(/\s{2,}/g, ' ')
          .trim()
      }
    }
  }
  return ''
}

function cleanExtractedValue(value: string) {
  return value
    .replace(/^[\s:;.,\-–—|=]+/, '')
    .replace(/[\s:;.,\-–—|=]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCorText(rawText: string, method: string): LocalCorExtraction {
  const text = normalizeWhitespace(rawText)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)

  // BIR CORs identify the legal/registered entity as "Name of Taxpayer". Always
  // prefer that label over generic "Registered Name" text elsewhere on the form.
  const taxpayerName = cleanExtractedValue(collectAfterLabelByPriority(lines, nameOfTaxpayerPatterns, 2))
  const fallbackRegisteredName = cleanExtractedValue(collectAfterLabelByPriority(lines, registeredNamePatterns, 2))
  const businessName = taxpayerName || fallbackRegisteredName

  // Trade Name is deliberately parsed independently so it cannot be swapped with
  // Name of Taxpayer when both labels are present in different parts of the COR.
  const tradeName = cleanExtractedValue(collectAfterLabelByPriority(lines, tradeNamePatterns, 2))

  const address = cleanExtractedValue(collectRegisteredAddress(lines))
  const tin = cleanExtractedValue(findTin(text, lines))
  const missing = [
    !businessName && 'Business / Registered Name',
    !tradeName && 'Trade Name',
    !tin && 'TIN',
    !address && 'Registered Address',
  ].filter(Boolean)

  const notes = missing.length
    ? `Processed using ${method}. Could not confidently detect: ${missing.join(', ')}. Please fill or correct those fields manually.`
    : `Processed using ${method}. Name of Taxpayer was mapped to Business / Registered Name. Please review the extracted values before generating the DRF.`

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
