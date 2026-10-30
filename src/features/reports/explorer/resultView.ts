// Data explorer: a query's result as a chart. The first column names the bars or slices; every column of numbers
// after it is a series.
import type { ChartData } from '../custom/reportData'
import type { SqlResult, SqlValue } from './sqlEngine'

const isNumber = (value: SqlValue) => typeof value === 'number' && Number.isFinite(value)

/** The columns that hold only numbers (empty cells allowed). */
export function numberColumns(result: SqlResult) {
  return result.columns
    .map((_, index) => index)
    .filter(
      index =>
        result.rows.some(row => isNumber(row[index])) &&
        result.rows.every(row => row[index] === null || isNumber(row[index])),
    )
}

export function resultChart(result: SqlResult, limit = 60): { chart: ChartData; valueLabel: string } | null {
  if (!result.rows.length) return null
  const numbers = numberColumns(result)
  const series = numbers.filter(index => index !== 0)
  if (!series.length) return null
  const rows = result.rows.slice(0, limit)
  const label = (value: SqlValue) => (value === null || value === '' ? 'None' : String(value))
  return {
    chart: {
      categories: rows.map((row, index) => ({ key: `${index}:${label(row[0])}`, label: label(row[0]) })),
      counts: rows.map(() => 1),
      series: series.slice(0, 8).map(index => ({
        key: result.columns[index],
        label: result.columns[index],
        values: rows.map(row => (isNumber(row[index]) ? (row[index] as number) : null)),
      })),
    },
    valueLabel: result.columns[series[0]],
  }
}

/** The single number a Number view shows: the first number in the first row. */
export function resultNumber(result: SqlResult): { value: number | null; label: string } {
  const row = result.rows[0]
  if (!row) return { value: null, label: result.columns[0] || '' }
  const index = row.findIndex(isNumber)
  return index < 0
    ? { value: null, label: result.columns[0] || '' }
    : { value: row[index] as number, label: result.columns[index] }
}

/** A result as CSV rows: the column names, then every row. */
export function resultCsv(result: SqlResult): string[][] {
  return [result.columns, ...result.rows.map(row => row.map(value => (value === null ? '' : String(value))))]
}
