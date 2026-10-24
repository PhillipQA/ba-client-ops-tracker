import { readFsdSource } from './fsd-sources'

type ProgressCallback = (message: string) => void

export type CorTextExtraction = {
  text: string
  method: string
}

export type LocalCorExtraction = {
  businessName: string
  tradeName: string
  tin: string
  address: string
  notes: string
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function lineKey(value: string) {
  return value
    .toUpperCase()
    .replace(/[|]/g, 'I')
    .replace(/[^A-Z0-9/:()&\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const nameOfTaxpayerPatterns = [/NAME\s*(?:OF\s*(?:THE\s*)?)?TAX\s*PAYER/, /TAX\s*PAYER\s*NAME/]

const registeredNamePatterns = [/REGISTERED\s*(?:BUSINESS\s*)?NAME/, /BUSINESS\s*REGISTERED\s*NAME/]

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

const tinLabelPatterns = [/TAX\s*PAYER\s*IDENTIFICATION\s*NUMBER/, /IDENTIFICATION\s*NUMBER\s*\(\s*TIN\s*\)/, /\bTIN\b/]

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
  return knownLabelPatterns.some(pattern => pattern.test(normalized))
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
  const remainder = line
    .slice(match.index + match[0].length)
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
  const tinLabelLine = lines.find(line => tinLabelPatterns.some(pattern => pattern.test(lineKey(line))))
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
        if (!parts.some(part => lineKey(part) === lineKey(cleaned))) parts.push(cleaned)
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

export function parseCorTextLocally(rawText: string, method: string): LocalCorExtraction {
  const text = normalizeWhitespace(rawText)
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

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

export async function extractCorTextLocally(file: File, onProgress?: ProgressCallback): Promise<CorTextExtraction> {
  const text = await readFsdSource(file, onProgress || (() => undefined))
  if (text.replace(/\[[^\]]*\]/g, '').replace(/\s/g, '').length < 20)
    throw new Error('The local extractor could not read enough text. Try a clearer scan or text-based PDF.')
  return {
    text,
    method:
      text.includes('[OCR text]') || /\.(png|jpe?g|webp|tiff?)$/i.test(file.name)
        ? 'local OCR with source review'
        : 'local document text extraction',
  }
}

export async function extractCorLocally(file: File, onProgress?: ProgressCallback): Promise<LocalCorExtraction> {
  const result = await extractCorTextLocally(file, onProgress)
  onProgress?.('Matching COR text to Business Name, Trade Name, TIN, and Address…')
  return parseCorTextLocally(result.text, result.method)
}
