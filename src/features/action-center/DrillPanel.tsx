/**
 * The list behind an Action Center number (drillDown.ts): search, sort by any column, click a task to open it, export
 * it as CSV, and, when the Tasks page's filters can show the same list, open it there.
 */
import { ArrowDown, ArrowUp, Download, ListChecks } from 'lucide-react'
import { useMemo, useState } from 'react'
import { csvText } from '../../shared/csv'
import { Dialog } from '../../shared/ui'
import { type Drill, type DrillRow, drillCsvRows, searchRows, sortRows } from './drillDown'

/** Rows shown at once; the rest are counted, and all of them go in the CSV. */
const SHOWN = 300

function downloadCsv(name: string, rows: string[][]) {
  const blob = new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'action-center'}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export function DrillPanel({
  drill,
  onClose,
  onOpenTask,
  onOpenInTasks,
}: {
  drill: Drill
  onClose: () => void
  onOpenTask: (taskId: string) => void
  /** Shown only when the list has a Tasks filter (drill.tasks). */
  onOpenInTasks?: () => void
}) {
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null)
  const rows = useMemo(() => {
    const found = searchRows(drill.rows, search)
    return order ? sortRows(found, order.key, order.direction) : found
  }, [drill.rows, search, order])
  const sortBy = (key: string) =>
    setOrder(current =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    )
  const open = (row: DrillRow) => {
    if (!row.taskId) return
    onClose()
    onOpenTask(row.taskId)
  }

  return (
    <Dialog title={drill.title} eyebrow={drill.subtitle || 'Action Center'} size="wide" onClose={onClose}>
      <div className="ac-drill">
        <div className="ac-drill-bar">
          <input
            type="search"
            value={search}
            placeholder="Search this list"
            aria-label="Search this list"
            onChange={event => setSearch(event.target.value)}
          />
          <span className="ac-drill-count">
            {rows.length === drill.rows.length ? `${rows.length}` : `${rows.length} of ${drill.rows.length}`}{' '}
            {drill.rows.length === 1 ? 'item' : 'items'}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={!rows.length}
            onClick={() => downloadCsv(drill.title, drillCsvRows(drill, rows))}
          >
            <Download size={14} /> Export CSV
          </button>
          {drill.tasks && onOpenInTasks && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onClose()
                onOpenInTasks()
              }}
            >
              <ListChecks size={14} /> Open in Tasks
            </button>
          )}
        </div>
        {drill.rows.length === 0 ? (
          <p className="ac-widget-note">Nothing here right now.</p>
        ) : (
          <div className="ac-drill-table">
            <table>
              <thead>
                <tr>
                  {drill.columns.map(column => (
                    <th
                      key={column.key}
                      className={column.numeric ? 'ac-drill-number' : undefined}
                      aria-sort={
                        order?.key === column.key ? (order.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                    >
                      <button type="button" onClick={() => sortBy(column.key)}>
                        {column.label}
                        {order?.key === column.key &&
                          (order.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, SHOWN).map(row => (
                  <tr
                    key={row.id}
                    className={row.taskId ? 'ac-drill-open' : undefined}
                    tabIndex={row.taskId ? 0 : undefined}
                    title={row.taskId ? 'Open the task' : undefined}
                    onClick={() => open(row)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') open(row)
                    }}
                  >
                    {drill.columns.map(column => (
                      <td key={column.key} className={column.numeric ? 'ac-drill-number' : undefined}>
                        {row.cells[column.key] || ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > SHOWN && (
              <p className="ac-widget-note">
                Showing {SHOWN} of {rows.length}. Search to narrow it, or export all of them.
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
