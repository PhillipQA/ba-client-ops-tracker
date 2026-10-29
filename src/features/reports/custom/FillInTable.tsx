// Custom reports: a table people type into, like a sheet. Click a cell to type; Enter goes down, Tab goes right,
// Escape stops. Rows copied from Excel or Google Sheets are pasted in from the cell being typed in.
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { niceDate } from './reportData'
import {
  enterCell,
  newId,
  parseClipboard,
  pasteInto,
  REPORT_LIMITS,
  type DataColumn,
  type DataRow,
  type DataTable,
} from './reportModel'
import { CHOICE_COLORS } from './ReportWidgets'

type Spot = { row: number; column: number }

function CellView({ column, value }: { column: DataColumn; value: string }) {
  if (!value) return null
  if (column.type === 'choice') {
    const color = column.options?.find(option => option.label === value)?.color || 'gray'
    return (
      <span className="crp-chip" style={{ ['--chip' as string]: CHOICE_COLORS[color] }}>
        {value}
      </span>
    )
  }
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return <>{niceDate(value)}</>
  return <>{value}</>
}

export function FillInTable({
  widgetId,
  table,
  editable,
  onChange,
}: {
  widgetId: string
  table: DataTable
  /** Whether this person may type into it now (their report, not a past week). */
  editable: boolean
  onChange: (table: DataTable) => void
}) {
  const [editing, setEditing] = useState<(Spot & { value: string }) | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = `crp-choices-${widgetId}`
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing?.row, editing?.column])

  const { columns, rows } = table
  const valueAt = (spot: Spot) => rows[spot.row]?.cells[columns[spot.column]?.id] || ''
  const start = (spot: Spot, value = valueAt(spot)) => {
    if (!editable || !columns[spot.column]) return
    setEditing({ ...spot, value })
  }
  /** Saves what was typed; the next cell, if any, is opened for typing. */
  const commit = (next: Spot | null) => {
    if (!editing) return
    const column = columns[editing.column]
    const entered = enterCell(column, editing.value)
    let nextRows: DataRow[] = rows
    let nextColumns = columns
    if (entered.value !== valueAt(editing)) {
      nextRows = rows.map((row, index) => {
        if (index !== editing.row) return row
        const cells = { ...row.cells }
        if (entered.value) cells[column.id] = entered.value
        else delete cells[column.id]
        return { ...row, cells }
      })
      nextColumns = columns.map((item, index) => (index === editing.column ? entered.column : item))
    }
    // Going down from the last row adds a row, as in a sheet.
    if (next && next.row >= nextRows.length && nextRows.length < REPORT_LIMITS.tableRows)
      nextRows = [...nextRows, { id: newId(), cells: {} }]
    if (nextRows !== rows || nextColumns !== columns) onChange({ columns: nextColumns, rows: nextRows })
    if (next && next.row < nextRows.length && next.column < columns.length)
      setEditing({ ...next, value: nextRows[next.row].cells[columns[next.column].id] || '' })
    else setEditing(null)
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(null)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      commit({ row: editing.row + (event.shiftKey ? -1 : 1), column: editing.column })
    } else if (event.key === 'Tab') {
      event.preventDefault()
      const forward = !event.shiftKey
      let { row, column } = editing
      column += forward ? 1 : -1
      if (column >= columns.length) {
        column = 0
        row++
      } else if (column < 0) {
        column = columns.length - 1
        row--
      }
      commit(row < 0 ? null : { row, column })
    }
  }
  /** Several cells copied from a sheet go in from this cell; one value is pasted as text. */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (!editing) return
    const textValue = event.clipboardData.getData('text/plain')
    if (!/[\t\n]/.test(textValue.replace(/\n$/, ''))) return
    event.preventDefault()
    onChange(pasteInto(table, editing.row, editing.column, parseClipboard(textValue)))
    setEditing(null)
  }
  const removeRow = (index: number) => {
    const row = rows[index]
    if (Object.values(row.cells).some(Boolean) && !window.confirm(`Delete row ${index + 1}?`)) return
    setEditing(null)
    onChange({ columns, rows: rows.filter((_, at) => at !== index) })
  }
  const addRow = () => {
    if (rows.length >= REPORT_LIMITS.tableRows) return
    onChange({ columns, rows: [...rows, { id: newId(), cells: {} }] })
    setEditing({ row: rows.length, column: 0, value: '' })
  }

  if (!columns.length) return <div className="crp-empty">This table has no columns yet. Add some in its settings.</div>
  return (
    <div className={`crp-fill${editable ? ' editable' : ''}`}>
      <div className="crp-table-wrap">
        <table className="crp-table crp-fill-table">
          <thead>
            <tr>
              <th className="crp-rownum" aria-label="Row" />
              {columns.map(column => (
                <th key={column.id} className={column.type === 'number' ? 'num' : ''}>
                  {column.name}
                </th>
              ))}
              {editable && <th className="crp-rowtools" aria-label="Delete" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.id}>
                <td className="crp-rownum">{rowIndex + 1}</td>
                {columns.map((column, columnIndex) => {
                  const here = editing?.row === rowIndex && editing.column === columnIndex
                  const value = row.cells[column.id] || ''
                  return (
                    <td
                      key={column.id}
                      className={`${column.type === 'number' ? 'num' : column.type === 'date' ? 'date' : ''}${here ? ' typing' : ''}`}
                      onClick={() => {
                        if (here) return
                        if (editing) commit(null)
                        start({ row: rowIndex, column: columnIndex })
                      }}
                    >
                      {here ? (
                        <input
                          ref={input}
                          value={editing.value}
                          aria-label={`${column.name}, row ${rowIndex + 1}`}
                          list={column.type === 'choice' ? listId + column.id : undefined}
                          inputMode={column.type === 'number' ? 'decimal' : undefined}
                          placeholder={column.type === 'date' ? 'Nov 4, 2025 or TBA' : undefined}
                          onChange={event => setEditing({ ...editing, value: event.target.value })}
                          onKeyDown={keys}
                          onPaste={paste}
                          onBlur={() => commit(null)}
                        />
                      ) : (
                        <span className="crp-cell-text">
                          <CellView column={column} value={value} />
                        </span>
                      )}
                    </td>
                  )
                })}
                {editable && (
                  <td className="crp-rowtools">
                    <button
                      type="button"
                      className="crp-icon small"
                      aria-label={`Delete row ${rowIndex + 1}`}
                      title="Delete row"
                      onClick={() => removeRow(rowIndex)}
                    >
                      <X size={13} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {columns
          .filter(column => column.type === 'choice')
          .map(column => (
            <datalist key={column.id} id={listId + column.id}>
              {(column.options || []).map(option => (
                <option key={option.label} value={option.label} />
              ))}
            </datalist>
          ))}
      </div>
      {editable && (
        <div className="crp-fill-foot no-print">
          <button type="button" className="crp-link" onClick={addRow} disabled={rows.length >= REPORT_LIMITS.tableRows}>
            <Plus size={13} /> Add row
          </button>
          <span className="crp-muted">Click a cell to type. Paste rows copied from Excel into any cell.</span>
        </div>
      )}
    </div>
  )
}
