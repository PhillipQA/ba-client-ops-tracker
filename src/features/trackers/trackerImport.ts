import {
  OPTION_COLORS,
  TRACKER_LIMITS,
  cleanCell,
  cleanSecret,
  isBasicType,
  randomId,
  validDate,
  type Cell,
  type ColumnType,
  type SelectOption,
  type TrackerColumn,
} from './trackerModel'

/**
 * Bringing a sheet in: read pasted cells or a CSV, guess what each column holds, match columns to the tracker,
 * and turn the cells into rows. Nothing here talks to the server. The result is shown for review first.
 */

// ---- reading the text ----

/** Splits pasted text into cells. Pasting from Google Sheets or Excel gives tabs; a CSV file gives commas or semicolons. */
export function parseTable(input: string): string[][] {
  const text = input.replace(/^﻿/, '')
  const firstLine = (() => {
    let quoted = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '"') quoted = !quoted
      else if (!quoted && (c === '\n' || c === '\r')) return text.slice(0, i)
    }
    return text
  })()
  const count = (c: string) => firstLine.split(c).length - 1
  const delimiter = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

export type Source = { headers: string[]; rows: string[][] }

/** Evens out ragged rows, drops empty rows and columns, and takes the header row. */
export function toSource(
  grid: string[][],
  firstRowIsHeader: boolean,
): { ok: true; source: Source } | { ok: false; error: string } {
  const filled = grid.map(row => row.map(cell => cell.replace(/\r\n?/g, '\n').trim())).filter(row => row.some(Boolean))
  if (!filled.length)
    return { ok: false, error: 'There is nothing to import. Paste cells from your sheet, or choose a CSV file.' }
  const width = Math.max(...filled.map(row => row.length))
  const even = filled.map(row => Array.from({ length: width }, (_, i) => row[i] ?? ''))
  const keep = Array.from({ length: width }, (_, i) => i).filter(i => even.some(row => row[i] !== ''))
  const trimmed = even.map(row => keep.map(i => row[i]))
  const headers = firstRowIsHeader
    ? trimmed[0].map((header, i) => header || `Column ${i + 1}`)
    : trimmed[0].map((_, i) => `Column ${i + 1}`)
  const rows = firstRowIsHeader ? trimmed.slice(1) : trimmed
  if (!headers.length)
    return { ok: false, error: 'There is nothing to import. Paste cells from your sheet, or choose a CSV file.' }
  if (headers.length > TRACKER_LIMITS.columns)
    return {
      ok: false,
      error: `A tracker can have at most ${TRACKER_LIMITS.columns} columns, and this sheet has ${headers.length}.`,
    }
  if (!rows.length) return { ok: false, error: 'The sheet has a header row but no rows under it.' }
  return { ok: true, source: { headers, rows } }
}

// ---- dates ----

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
const fullYear = (y: number) => (y < 100 ? 2000 + y : y)
function iso(y: number, m: number, d: number) {
  const text = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
  return validDate(text) ? text : ''
}

/** Reads the date formats people actually type into sheets. Returns a calendar date as YYYY-MM-DD, or '' if the text is not a date. */
export function parseLooseDate(input: string, today: string, dayFirst = false): string {
  const text = input.trim().replace(/\s+/g, ' ')
  const year = Number(today.slice(0, 4))
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(text)
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return dayFirst ? iso(fullYear(Number(m[3])), b, a) : iso(fullYear(Number(m[3])), a, b)
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(text)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return dayFirst ? iso(year, b, a) : iso(year, a, b)
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{2}|\d{4}))?$/.exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    return month < 0 ? '' : iso(m[3] ? fullYear(Number(m[3])) : year, month + 1, Number(m[2]))
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.?(?:,? (\d{2}|\d{4}))?$/.exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    return month < 0 ? '' : iso(m[3] ? fullYear(Number(m[3])) : year, month + 1, Number(m[1]))
  }
  return ''
}

/** True when a column of slash dates reads as day/month: some value has a first part above 12 and a second part that is a month. */
export function looksDayFirst(values: string[]) {
  return values.some(value => {
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(value.trim())
    return Boolean(m) && Number(m![1]) > 12 && Number(m![2]) <= 12
  })
}

// ---- guessing what a column holds ----

const SECRET_HEADER = /\b(pass(words?|wd|code|phrase)?|pwd|secrets?|tokens?|api[ _-]?keys?|pin|credentials?)\b/i
const YES = new Set(['yes', 'y', 'true', 'x', '✓', '✔', 'done', 'checked'])
const NO = new Set(['no', 'n', 'false', 'unchecked'])
const NUMBER = /^[-+]?(?:[$€£₱¥]\s?)?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^[-+]?(?:[$€£₱¥]\s?)?\d+(?:\.\d+)?$/
const isUrl = (value: string) => /^https?:\/\/[^\s/]+\.[^\s/]+\S*$/i.test(value)

export type Guess = { type: ColumnType; options: string[] }

export function guessColumn(header: string, values: string[], isFirst: boolean, today: string): Guess {
  const filled = values.map(v => v.trim()).filter(Boolean)
  const text: Guess = { type: 'text', options: [] }
  if (!isFirst && SECRET_HEADER.test(header)) return { type: 'secret', options: [] }
  if (!filled.length || isFirst) return text
  const dayFirst = looksDayFirst(filled)
  if (filled.every(v => parseLooseDate(v, today, dayFirst))) return { type: 'date', options: [] }
  if (filled.every(v => NUMBER.test(v)) && !filled.some(v => /^0\d/.test(v.replace(/^[^\d]*/, '')) && !v.includes('.')))
    return { type: 'number', options: [] }
  const lowered = filled.map(v => v.toLowerCase())
  if (lowered.every(v => YES.has(v) || NO.has(v)) && new Set(lowered).size <= 3)
    return { type: 'checkbox', options: [] }
  if (filled.every(isUrl)) return { type: 'link', options: [] }
  if (filled.some(v => v.includes('\n') || v.length > 120)) return { type: 'longtext', options: [] }
  const firstSeen = new Map<string, string>()
  for (const v of filled) if (!firstSeen.has(v.toLowerCase())) firstSeen.set(v.toLowerCase(), v)
  const distinct = [...firstSeen.values()]
  if (filled.length >= 4 && distinct.length <= 12 && distinct.length <= filled.length * 0.6)
    return { type: 'select', options: distinct.slice(0, TRACKER_LIMITS.optionsPerColumn) }
  return text
}

// ---- matching the sheet to the tracker ----

/** `target` is an existing column id, or 'new' to add a column for it. */
export type Mapping = {
  index: number
  include: boolean
  target: string
  name: string
  type: ColumnType
  options: string[]
}

const clean = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export function defaultMappings(source: Source, existing: TrackerColumn[], today: string): Mapping[] {
  const taken = new Set<string>()
  return source.headers.map((header, index) => {
    const match = existing.find(
      column =>
        !taken.has(column.id) &&
        column.type !== 'task_status' &&
        column.type !== 'task_due' &&
        column.type !== 'task_owner' &&
        column.type !== 'signoff' &&
        column.type !== 'drive_files' &&
        column.type !== 'formula' &&
        clean(column.name) === clean(header),
    )
    if (match) {
      taken.add(match.id)
      return { index, include: true, target: match.id, name: match.name, type: match.type, options: [] }
    }
    const guess = guessColumn(
      header,
      source.rows.map(row => row[index] || ''),
      index === 0 && !existing.length,
      today,
    )
    return {
      index,
      include: true,
      target: 'new',
      name: header.slice(0, TRACKER_LIMITS.columnName),
      type: guess.type,
      options: guess.options,
    }
  })
}

export type Person = { id: string; name: string; email?: string; username?: string }
export type ImportRow = { cells: Record<string, Cell>; secrets: Record<string, string>; sourceRow: number }
export type ImportPlan = {
  columns: TrackerColumn[]
  rows: ImportRow[]
  added: TrackerColumn[]
  /** Cells that could not be read and were left empty, so they can be checked against the sheet. */
  problems: { row: number; column: string; value: string; message: string }[]
  warnings: string[]
  fatal: string
}

const nextColor = (count: number) => OPTION_COLORS[(count % (OPTION_COLORS.length - 1)) + 1]

/** Turns a sheet into rows for the tracker. `row` numbers in problems are the sheet's own row numbers (the header is row 1). */
export function planImport(
  source: Source,
  mappings: Mapping[],
  existing: TrackerColumn[],
  context: { today: string; people: Person[]; capacity: number; firstRowIsHeader: boolean },
): ImportPlan {
  const plan: ImportPlan = {
    columns: existing.map(column => ({ ...column, options: column.options?.map(option => ({ ...option })) })),
    rows: [],
    added: [],
    problems: [],
    warnings: [],
    fatal: '',
  }
  const used = new Set(plan.columns.map(column => column.name.toLowerCase()))
  const byId = new Map(plan.columns.map(column => [column.id, column]))
  const chosen = mappings.filter(mapping => mapping.include)
  const targets = new Map<number, TrackerColumn>()
  const seenTargets = new Set<string>()
  for (const mapping of chosen) {
    if (mapping.target === 'new') {
      if (!isBasicType(mapping.type) && mapping.type !== 'secret') {
        plan.fatal = `"${mapping.name}" is a column that fills itself, so a sheet cannot supply it.`
        return plan
      }
      let name = (mapping.name.trim() || `Column ${mapping.index + 1}`).slice(0, TRACKER_LIMITS.columnName),
        n = 2
      while (used.has(name.toLowerCase())) name = `${name.slice(0, TRACKER_LIMITS.columnName - 4)} ${n++}`
      used.add(name.toLowerCase())
      const column: TrackerColumn = { id: randomId('c_'), name, type: mapping.type }
      if (mapping.type === 'select' || mapping.type === 'multiselect') column.options = []
      if (mapping.type === 'secret') column.revealBy = 'editors'
      plan.columns.push(column)
      plan.added.push(column)
      byId.set(column.id, column)
      targets.set(mapping.index, column)
    } else {
      const column = byId.get(mapping.target)
      if (!column) {
        plan.fatal = `A column you chose no longer exists. Go back and choose again.`
        return plan
      }
      if (!isBasicType(column.type) && column.type !== 'secret') {
        plan.fatal = `"${column.name}" fills itself from the linked task, so a sheet cannot supply it.`
        return plan
      }
      if (seenTargets.has(column.id)) {
        plan.fatal = `Two sheet columns are matched to "${column.name}". Choose a different column for one of them.`
        return plan
      }
      seenTargets.add(column.id)
      targets.set(mapping.index, column)
    }
  }
  if (plan.columns.length > TRACKER_LIMITS.columns) {
    plan.fatal = `That would give the tracker ${plan.columns.length} columns. The limit is ${TRACKER_LIMITS.columns}.`
    return plan
  }
  if (!targets.size) {
    plan.fatal = 'Choose at least one column to import.'
    return plan
  }
  if (source.rows.length > context.capacity) {
    plan.fatal = `This tracker has room for ${context.capacity.toLocaleString('en')} more rows, and the sheet has ${source.rows.length.toLocaleString('en')}.`
    return plan
  }

  const dayFirst = new Map<number, boolean>()
  for (const [index, column] of targets)
    if (column.type === 'date') dayFirst.set(index, looksDayFirst(source.rows.map(row => row[index] || '')))
  const unmatched = new Map<string, number>()
  const peopleBy = new Map<string, string>()
  for (const person of context.people)
    for (const key of [person.name, person.email, person.username])
      if (key) peopleBy.set(key.trim().toLowerCase(), person.id)

  const optionFor = (column: TrackerColumn, label: string): SelectOption | undefined => {
    const wanted = label.trim()
    if (!wanted) return undefined
    column.options ||= []
    const found = column.options.find(option => option.label.toLowerCase() === wanted.toLowerCase())
    if (found) return found
    if (column.options.length >= TRACKER_LIMITS.optionsPerColumn) return undefined
    const created: SelectOption = {
      id: randomId('o_'),
      label: wanted.slice(0, TRACKER_LIMITS.optionLabel),
      color: nextColor(column.options.length),
    }
    column.options.push(created)
    return created
  }

  source.rows.forEach((sourceRow, rowIndex) => {
    const sheetRow = rowIndex + (context.firstRowIsHeader ? 2 : 1)
    const row: ImportRow = { cells: {}, secrets: {}, sourceRow: sheetRow }
    for (const [index, column] of targets) {
      const raw = (sourceRow[index] || '').trim()
      if (!raw) continue
      const problem = (message: string) =>
        plan.problems.push({ row: sheetRow, column: column.name, value: raw.slice(0, 60), message })
      if (column.type === 'secret') {
        const result = cleanSecret(column, raw)
        if (result.ok) row.secrets[column.id] = result.value
        else problem(result.error)
        continue
      }
      let candidate: unknown = raw
      if (column.type === 'number') {
        const stripped = raw.replace(/[^\d.\-+]/g, '')
        candidate = /\d/.test(stripped) ? stripped : raw
      } else if (column.type === 'date') {
        const date = parseLooseDate(raw, context.today, dayFirst.get(index))
        if (!date) {
          problem('Not a date.')
          continue
        }
        candidate = date
      } else if (column.type === 'select') {
        const option = optionFor(column, raw)
        if (!option) {
          problem('Too many options in this column.')
          continue
        }
        candidate = option.id
      } else if (column.type === 'multiselect') {
        const ids: string[] = []
        for (const part of raw.split(/\s*[,;\n]\s*/)) {
          const option = optionFor(column, part)
          if (option && !ids.includes(option.id)) ids.push(option.id)
        }
        candidate = ids
      } else if (column.type === 'person') {
        const id = peopleBy.get(raw.toLowerCase())
        if (!id) {
          unmatched.set(raw, (unmatched.get(raw) || 0) + 1)
          continue
        }
        candidate = id
      }
      const result = cleanCell(column, candidate)
      if (result.ok) row.cells[column.id] = result.value
      else problem(result.error)
    }
    if (Object.keys(row.cells).length || Object.keys(row.secrets).length) plan.rows.push(row)
  })
  for (const [name, count] of unmatched)
    plan.warnings.push(
      `No teammate matches "${name}"${count > 1 ? ` (${count} rows)` : ''}. Those cells were left empty.`,
    )
  if (!plan.rows.length) plan.fatal = 'No rows could be read from this sheet.'
  return plan
}
