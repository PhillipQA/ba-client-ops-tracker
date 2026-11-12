/**
 * Reads an Excel workbook (.xlsx) kept in Google Drive, for trackers that follow one: the tabs, and each tab's cells as
 * text the way the Sheets API returns them (header row first). Read only: the tracker never writes to an Excel file.
 * No dependencies: an .xlsx is a zip of XML files, unpacked with zlib.
 */
import { inflateRawSync } from 'node:zlib'

/** Larger files are refused before they are read. */
export const XLSX_MAX_BYTES = 20 * 1024 * 1024
/** The most one part of the file may unpack to, so a tiny file cannot unpack to gigabytes. */
const MAX_PART = 100 * 1024 * 1024

export const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export class XlsxError extends Error {}

type Entry = { method: number; size: number; offset: number; compressed: number }

function zipEntries(data: Buffer): Map<string, Entry> {
  let end = -1
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at -= 1)
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) throw new XlsxError('This file is not an Excel workbook (.xlsx), or it is damaged.')
  const count = data.readUInt16LE(end + 10)
  let at = data.readUInt32LE(end + 16)
  const entries = new Map<string, Entry>()
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50)
      throw new XlsxError('This Excel file is damaged and could not be read.')
    const nameLength = data.readUInt16LE(at + 28),
      extraLength = data.readUInt16LE(at + 30),
      commentLength = data.readUInt16LE(at + 32)
    const name = data.toString('utf8', at + 46, at + 46 + nameLength)
    entries.set(name.replace(/^\/+/, ''), {
      method: data.readUInt16LE(at + 10),
      compressed: data.readUInt32LE(at + 20),
      size: data.readUInt32LE(at + 24),
      offset: data.readUInt32LE(at + 42),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function unpack(data: Buffer, entry: Entry): string {
  const at = entry.offset
  if (at + 30 > data.length || data.readUInt32LE(at) !== 0x04034b50)
    throw new XlsxError('This Excel file is damaged and could not be read.')
  const start = at + 30 + data.readUInt16LE(at + 26) + data.readUInt16LE(at + 28)
  const raw = data.subarray(start, start + entry.compressed)
  if (entry.method === 0) return raw.toString('utf8')
  if (entry.method !== 8) throw new XlsxError('This Excel file uses a format the tracker cannot read.')
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_PART }).toString('utf8')
  } catch {
    throw new XlsxError('This Excel file is too large or damaged to read.')
  }
}

const decode = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

const attr = (attrs: string, name: string) => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  return match ? decode(match[1]) : undefined
}

/** All the text of a string item: plain, or rich text in runs. Phonetic hints are left out. */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map(match => decode(match[1]))
    .join('')

/** Built-in number formats that show dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])
const PERCENT_FORMATS = new Set([9, 10])

function looksLikeDate(code: string) {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '')
  return /[dmyhs]/i.test(bare)
}

const columnIndex = (ref: string) => {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() || ''
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

const pad = (value: number) => String(value).padStart(2, '0')

/** An Excel date number as an ISO date (with the time when it has one). */
export function excelDate(serial: number, date1904 = false) {
  const days = date1904 ? serial + 1462 : serial
  const at = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86400000))
  if (Number.isNaN(at.getTime())) return String(serial)
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
  const time = at.getUTCHours() || at.getUTCMinutes() ? ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}` : ''
  return days >= 1 ? date + time : `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
}

const plainNumber = (value: number) => String(Number.parseFloat(value.toPrecision(15)))

export type Workbook = {
  tabs: { title: string; rows: number; columns: number }[]
  /** One tab's cells as text, header row first; null when there is no tab with that name. */
  grid: (title: string, limits?: { rows?: number; columns?: number }) => string[][] | null
}

export function readXlsx(data: Buffer): Workbook {
  if (data.length > XLSX_MAX_BYTES) throw new XlsxError('This Excel file is larger than 20 MB, too large to follow.')
  const entries = zipEntries(data)
  const part = (name: string) => {
    const entry = entries.get(name)
    return entry ? unpack(data, entry) : ''
  }
  const workbook = part('xl/workbook.xml')
  if (!workbook) throw new XlsxError('This file is not an Excel workbook (.xlsx).')
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook)

  const targets = new Map<string, string>()
  for (const match of part('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(match[1], 'Id'),
      target = attr(match[1], 'Target')
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)]
    .map(match => ({
      title: attr(match[1], 'name') || '',
      path: targets.get(attr(match[1], 'r:id') || '') || '',
      hidden: Boolean(attr(match[1], 'state') && attr(match[1], 'state') !== 'visible'),
    }))
    .filter(sheet => sheet.title && sheet.path && entries.has(sheet.path))

  let shared: string[] | null = null
  const sharedStrings = () =>
    (shared ??= [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(match =>
      textOf(match[1] || ''),
    ))

  let styles: { dates: Set<number>; percents: Set<number> } | null = null
  const styleSets = () => {
    if (styles) return styles
    const xml = part('xl/styles.xml')
    const custom = new Map<number, string>()
    for (const match of xml.matchAll(/<numFmt\b([^>]*?)\/?>/g))
      custom.set(Number(attr(match[1], 'numFmtId')), attr(match[1], 'formatCode') || '')
    const dates = new Set<number>(),
      percents = new Set<number>()
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || ''
    ;[...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].forEach((match, index) => {
      const id = Number(attr(match[1], 'numFmtId') || 0),
        code = custom.get(id)
      if (code !== undefined ? looksLikeDate(code) : DATE_FORMATS.has(id)) dates.add(index)
      else if (code !== undefined ? /%/.test(code.replace(/"[^"]*"/g, '')) : PERCENT_FORMATS.has(id))
        percents.add(index)
    })
    return (styles = { dates, percents })
  }

  const dimension = (path: string) => {
    const xml = part(path)
    const ref = /<dimension\b[^>]*\bref="([^"]+)"/.exec(xml)?.[1] || ''
    const [, last = ref.split(':')[0] || 'A1'] = ref.split(':')
    return {
      rows: Number(/\d+$/.exec(last)?.[0] || 0),
      columns: columnIndex(last) + 1,
    }
  }

  return {
    tabs: sheets.filter(sheet => !sheet.hidden).map(sheet => ({ title: sheet.title, ...dimension(sheet.path) })),
    grid(title, limits = {}) {
      const sheet = sheets.find(item => item.title === title) || sheets.find(item => item.title.trim() === title.trim())
      if (!sheet) return null
      const maxRows = limits.rows ?? Number.MAX_SAFE_INTEGER,
        maxColumns = limits.columns ?? 16384
      const xml = part(sheet.path)
      const grid: string[][] = []
      let nextRow = 0
      for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const number = Number(attr(row[1], 'r') || 0)
        const rowIndex = number > 0 ? number - 1 : nextRow
        nextRow = rowIndex + 1
        if (rowIndex >= maxRows) break
        const values: string[] = []
        let nextColumn = 0
        for (const cell of (row[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attr(cell[1], 'r')
          const column = ref ? columnIndex(ref) : nextColumn
          nextColumn = column + 1
          if (column >= maxColumns) continue
          const body = cell[2] || ''
          const type = attr(cell[1], 't') || 'n'
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
          let text = ''
          if (type === 'inlineStr') text = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] || '')
          else if (raw === undefined) text = ''
          else if (type === 's') text = sharedStrings()[Number(raw)] ?? ''
          else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE'
          else if (type === 'str' || type === 'e') text = decode(raw)
          else {
            const value = Number(raw)
            const style = Number(attr(cell[1], 's') || 0)
            if (!Number.isFinite(value)) text = decode(raw)
            else if (styleSets().dates.has(style)) text = excelDate(value, date1904)
            else if (styleSets().percents.has(style)) text = `${plainNumber(value * 100)}%`
            else text = plainNumber(value)
          }
          while (values.length < column) values.push('')
          values[column] = text
        }
        while (values.length && !values[values.length - 1].trim()) values.pop()
        while (grid.length < rowIndex) grid.push([])
        grid[rowIndex] = values
      }
      while (grid.length && !grid[grid.length - 1].length) grid.pop()
      return grid
    },
  }
}
