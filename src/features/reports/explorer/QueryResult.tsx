// Data explorer: a query's result as a grid, a chart or one number. Also used by query widgets on reports.
import { useEffect, useState } from 'react'
import { formatNumber, niceDate } from '../custom/reportData'
import type { QueryView, SavedQuery, Widget } from '../custom/reportModel'
import { WidgetBody } from '../custom/ReportWidgets'
import { resultChart, resultNumber } from './resultView'
import { SqlError, type SqlResult, type SqlValue } from './sqlEngine'

const GRID_ROWS = 500
const show = (value: SqlValue) => {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return formatNumber(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return niceDate(value)
  return value
}

/** Cells a report lets people type into: their tracker row is saved when they press Enter or leave the cell. */
export type ResultEditing = {
  columns: boolean[]
  save: (rowIndex: number, columnIndex: number, text: string) => Promise<void>
}

function EditableCell({ value, onSave }: { value: SqlValue; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const start = () => {
    setText(value === null ? '' : String(value))
    setProblem('')
    setEditing(true)
  }
  const finish = async () => {
    if (busy) return
    if (text === (value === null ? '' : String(value))) return setEditing(false)
    setBusy(true)
    try {
      await onSave(text)
      setEditing(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Not saved. Try again.')
    } finally {
      setBusy(false)
    }
  }
  if (!editing)
    return (
      <button type="button" className="dx-edit-cell" title="Type to change it in the tracker" onClick={start}>
        {show(value) || <span className="dx-edit-empty">Add…</span>}
      </button>
    )
  return (
    <span className="dx-edit-box">
      <input
        // biome-ignore lint/a11y/noAutofocus: the person just chose this cell to type in
        autoFocus
        aria-label="Edit cell"
        value={text}
        disabled={busy}
        onChange={event => setText(event.target.value)}
        onBlur={() => void finish()}
        onKeyDown={event => {
          if (event.key === 'Enter') void finish()
          if (event.key === 'Escape') setEditing(false)
        }}
      />
      {problem && (
        <small className="dx-edit-problem" role="alert">
          {problem}
        </small>
      )}
    </span>
  )
}

export function QueryResultView({
  result,
  view,
  today,
  edit,
}: {
  result: SqlResult
  view: QueryView
  today: string
  edit?: ResultEditing
}) {
  if (view === 'number') {
    const { value, label } = resultNumber(result)
    return (
      <div className="crp-metric">
        <strong>{formatNumber(value)}</strong>
        <span>{label}</span>
      </div>
    )
  }
  if (view !== 'table') {
    const chart = resultChart(result)
    if (!chart)
      return (
        <div className="crp-empty">
          {result.rows.length
            ? 'To chart this, put a name column first and at least one column of numbers after it.'
            : 'No rows.'}
        </div>
      )
    const widget: Widget = {
      id: 'result',
      kind: view,
      title: '',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      source: 'tasks',
      filters: [],
      measure: { op: 'max' },
      valueLabel: chart.valueLabel,
      limit: 60,
    }
    return (
      <WidgetBody
        widget={widget}
        computed={{ kind: 'chart', chart: chart.chart, rows: result.rows.length }}
        fields={[]}
        today={today}
      />
    )
  }
  if (!result.rows.length) return <div className="crp-empty">No rows.</div>
  const numeric = result.columns.map((_, index) =>
    result.rows.every(row => row[index] === null || typeof row[index] === 'number'),
  )
  return (
    <div className="crp-table-wrap">
      <table className="crp-table dx-grid">
        <thead>
          <tr>
            {result.columns.map((column, index) => (
              <th
                key={column}
                className={numeric[index] ? 'num' : ''}
                title={edit?.columns[index] ? 'You can type in this column; it saves to the tracker.' : undefined}
              >
                {column}
                {edit?.columns[index] ? ' ✎' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.slice(0, GRID_ROWS).map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no id of their own
            <tr key={rowIndex}>
              {row.map((value, index) => (
                <td key={result.columns[index]} className={numeric[index] ? 'num' : value === null ? 'dx-null' : ''}>
                  {edit?.columns[index] ? (
                    <EditableCell value={value} onSave={text => edit.save(rowIndex, index, text)} />
                  ) : (
                    show(value)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > GRID_ROWS && (
        <p className="crp-more">
          Showing the first {GRID_ROWS} of {result.rows.length} rows. The CSV has them all.
        </p>
      )}
    </div>
  )
}

export type QueryRunner = (sql: string, params: Record<string, string>) => Promise<SqlResult>

/** Runs a saved query whenever it changes, for widgets on reports. */
export function useQueryRun(run: QueryRunner, query: SavedQuery | undefined, refresh: unknown) {
  const [state, setState] = useState<{ result: SqlResult | null; error: string; running: boolean }>({
    result: null,
    error: '',
    running: false,
  })
  const key = JSON.stringify(query || null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query's text stands for the query; refresh reruns it
  useEffect(() => {
    if (!query?.sql.trim()) {
      setState({ result: null, error: 'Write the query in this widget’s settings.', running: false })
      return
    }
    let active = true
    setState(current => ({ ...current, running: true }))
    run(query.sql, query.params)
      .then(result => active && setState({ result, error: '', running: false }))
      .catch(
        error =>
          active &&
          setState({
            result: null,
            error: error instanceof SqlError ? error.message : 'This query could not run.',
            running: false,
          }),
      )
    return () => {
      active = false
    }
  }, [key, refresh])
  return state
}
