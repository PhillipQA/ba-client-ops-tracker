import type { TrackerColumn, TrackerRow } from './trackerModel'
import { shown, type Lookup } from './trackerQuery'

/** A spreadsheet runs text that starts with these as a formula. A leading apostrophe keeps it as text. */
const FORMULA_START = /^[=+\-@\t\r]/

export function csvField(value: string, isText: boolean) {
  const safe = isText && FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * The rows as CSV, in the order given. Secret columns are never exported. Connected columns are exported as shown.
 * The file starts with a byte order mark so Excel reads accented characters correctly.
 */
export function exportCsv(columns: TrackerColumn[], rows: TrackerRow[], lookup: Lookup) {
  const included = columns.filter(column => column.type !== 'secret')
  const lines = [included.map(column => csvField(column.name, true)).join(',')]
  for (const row of rows) {
    lines.push(
      included
        .map(column => {
          const cell = shown(column, row, lookup)
          // Numbers stay numbers, so a negative amount is not mistaken for text that needs the apostrophe.
          return csvField(cell.text, column.type !== 'number')
        })
        .join(','),
    )
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

export function exportFileName(name: string, today: string) {
  const base =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'Tracker'
  return `${base} ${today}.csv`
}
