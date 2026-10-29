import { useMemo, useState } from 'react'
import type { WorkItem } from '../../shared/types'
import type { TaskLink } from './trackerApi'
import type { TrackerColumn, TrackerRow } from './trackerModel'
import { Dialog, plural } from './trackerUi'
import type { TaskDraft } from './TrackerWork'

export type ColumnSubtaskLink = { rowId: string; columnId: string; taskId: string }

/**
 * Columns that just came over from the Sheet: choose which of them, and which rows, get a subtask under the row's
 * task. Each subtask is named after its column and its status shows in that cell, as in the review of new rows.
 * Rows without a task (or whose task is itself a subtask) cannot hold one; they are counted, not listed.
 */
export default function TrackerColumnSubtasks(props: {
  columns: TrackerColumn[]
  rows: TrackerRow[]
  items: WorkItem[]
  links: TaskLink[]
  rowTitle: (row: TrackerRow) => string
  onCreate: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  onLinks: (links: ColumnSubtaskLink[]) => Promise<void>
  /** Done with these columns: created, or decided against. */
  onDone: (columnIds: string[]) => void
  onClose: () => void
}) {
  const items = useMemo(() => new Map(props.items.map(item => [item.id, item])), [props.items])
  const eligible = props.rows.filter(row => {
    const task = row.taskId ? items.get(row.taskId) : undefined
    return task && !task.parentTaskId && !task.archived
  })
  const without = props.rows.length - eligible.length
  const [columnIds, setColumnIds] = useState(() => new Set(props.columns.map(column => column.id)))
  const [rowIds, setRowIds] = useState(() => new Set(eligible.map(row => row.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const linked = new Set(props.links.map(link => `${link.rowId}:${link.columnId}`))
  const planned = eligible.flatMap(row =>
    rowIds.has(row.id)
      ? props.columns
          .filter(column => columnIds.has(column.id) && !linked.has(`${row.id}:${column.id}`))
          .map(column => ({ row, column }))
      : [],
  )
  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }
  const create = async () => {
    if (busy || !planned.length) return
    setBusy(true)
    setError('')
    try {
      const made = await props.onCreate(
        planned.map(entry => ({
          title: entry.column.name,
          clientId: '',
          projectId: '',
          parentTaskId: entry.row.taskId,
        })),
      )
      await props.onLinks(
        made.flatMap((item, at) =>
          planned[at] ? [{ rowId: planned[at].row.id, columnId: planned[at].column.id, taskId: item.id }] : [],
        ),
      )
      props.onDone(props.columns.map(column => column.id))
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The subtasks could not be created.')
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Subtasks for the new Sheet columns"
      eyebrow="Trackers"
      onClose={props.onClose}
      busy={busy}
      size="medium"
    >
      <div className="trk-new">
        <p className="trk-muted-text">
          {plural(props.columns.length, 'column')} came over from the Google Sheet. A subtask per column can go under
          each row's task: it is named after the column, and its status shows in that cell.
        </p>
        <fieldset className="trk-starter">
          <legend>Columns</legend>
          {props.columns.map(column => (
            <label key={column.id} className="trk-checkline">
              <input
                type="checkbox"
                checked={columnIds.has(column.id)}
                onChange={event => setColumnIds(current => toggle(current, column.id, event.target.checked))}
              />{' '}
              {column.name}
            </label>
          ))}
        </fieldset>
        {eligible.length ? (
          <fieldset className="trk-starter trk-subtask-rows">
            <legend>
              Rows ({rowIds.size} of {eligible.length}){' '}
              <button
                type="button"
                className="trk-text-button"
                onClick={() =>
                  setRowIds(rowIds.size === eligible.length ? new Set() : new Set(eligible.map(row => row.id)))
                }
              >
                {rowIds.size === eligible.length ? 'None' : 'All'}
              </button>
            </legend>
            {eligible.map(row => (
              <label key={row.id} className="trk-checkline">
                <input
                  type="checkbox"
                  checked={rowIds.has(row.id)}
                  onChange={event => setRowIds(current => toggle(current, row.id, event.target.checked))}
                />{' '}
                {props.rowTitle(row)} <span className="trk-muted-text">· {items.get(row.taskId)?.title}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="trk-muted-text">No row has a task yet, so there is nothing to put subtasks under.</p>
        )}
        {without > 0 && (
          <p className="trk-muted-text">
            {plural(without, 'row')} {without === 1 ? 'has' : 'have'} no task of its own (or{' '}
            {without === 1 ? 'is' : 'are'} a subtask already) and {without === 1 ? 'is' : 'are'} left as{' '}
            {without === 1 ? 'it is' : 'they are'}. New rows from the Sheet can get these subtasks in their review.
          </p>
        )}
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <button
            type="button"
            className="trk-button"
            disabled={busy}
            onClick={() => {
              props.onDone(props.columns.map(column => column.id))
              props.onClose()
            }}
          >
            No subtasks
          </button>
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={props.onClose}>
            Not now
          </button>
          <button
            type="button"
            className="trk-button primary"
            disabled={busy || !planned.length}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : `Create ${plural(planned.length, 'subtask')}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
