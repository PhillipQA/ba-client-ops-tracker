/**
 * CSV for exports people open in Excel or Google Sheets. Text that starts with = + - @ (or a tab or carriage return)
 * is run as a formula when the file is opened, even inside quotes, and such text can come from outside the account:
 * email subjects and senders, Google Sheets that clients edit, Discord messages. A leading apostrophe keeps it as
 * text. Plain numbers, including negative ones, are left as they are.
 */
const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^[+-]?(\d[\d,]*(\.\d+)?|\.\d+)(e[+-]?\d+)?%?$/i

/** One CSV field, always quoted. */
export function csvCell(value: unknown) {
  const text = String(value ?? '')
  const safe = FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

/** Rows as CSV text. */
export const csvText = (rows: unknown[][]) => rows.map(row => row.map(csvCell).join(',')).join('\n')
