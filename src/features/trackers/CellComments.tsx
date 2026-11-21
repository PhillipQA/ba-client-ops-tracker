/**
 * Comments on a tracker cell (see cellComments.ts): the tooltip shown while the pointer is over a cell with a corner,
 * and the box that opens on right-click or Ctrl+Alt+M to write one.
 *
 * A cell linked to a Task or Subtask writes into that task's Comments; any other cell keeps the comment in the tracker,
 * where @mentions notify people, as in row comments.
 */
import { MessageSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { addTaskComment } from '../tasks/taskComments'
import { type CellTipEntry, tipOf, tipText } from './cellComments'
import { trackerApi } from './trackerApi'
import { CommentBox } from './TrackerComments'
import type { Mentionable, RowComment } from './trackerComments'
import { niceTime } from './trackerUi'

type Place = { top: number; left: number }

/** Just below the cell, kept inside the window. */
function placeBy(anchor: DOMRect, width: number): Place {
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  const below = anchor.bottom + 4
  return { top: below + 200 > window.innerHeight ? Math.max(8, anchor.top - 204) : below, left }
}

export function CellCommentTip({
  anchor,
  entries,
  columnName,
  taskTitle,
}: {
  anchor: DOMRect
  entries: CellTipEntry[]
  columnName: string
  taskTitle?: string
}) {
  const { shown, more } = tipOf(entries)
  const place = placeBy(anchor, 320)
  return (
    <div className="trk-cell-tip" role="tooltip" style={{ top: place.top, left: place.left }}>
      <p className="trk-cell-tip-head">
        <MessageSquare size={12} aria-hidden="true" /> {columnName}
        {taskTitle ? ` · in ${taskTitle}` : ''}
      </p>
      {more > 0 && (
        <p className="trk-cell-tip-more">
          {more} earlier comment{more === 1 ? '' : 's'}
        </p>
      )}
      <ol>
        {shown.map(entry => (
          <li key={`${entry.source}:${entry.id}`}>
            <span className="trk-cell-tip-who">
              <strong>{entry.author}</strong>
              <time dateTime={entry.at}>
                {niceTime(entry.at)}
                {entry.edited ? ' · edited' : ''}
              </time>
            </span>
            <span>{tipText(entry.text)}</span>
          </li>
        ))}
      </ol>
      <p className="trk-cell-tip-more">Right-click the cell to comment.</p>
    </div>
  )
}

export function CellCommentBox({
  trackerId,
  rowId,
  columnId,
  columnName,
  anchor,
  entries,
  task,
  onClose,
  onCellComment,
  onTaskComment,
}: {
  trackerId: string
  rowId: string
  columnId: string
  columnName: string
  anchor: DOMRect
  entries: CellTipEntry[]
  /** The Task or Subtask linked to the cell: the comment goes into its Comments. */
  task?: { id: string; title: string; kind: 'Task' | 'Subtask' }
  onClose: () => void
  onCellComment: (comment: RowComment) => void
  onTaskComment: () => Promise<void> | void
}) {
  const [people, setPeople] = useState<Mentionable[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const place = placeBy(anchor, 340)

  // @mentions are for the tracker's own comments; a task's comments have none.
  useEffect(() => {
    if (task) return
    const controller = new AbortController()
    trackerApi
      .comments(trackerId, rowId, controller.signal)
      .then(result => setPeople(result.mentionable))
      .catch(() => undefined)
    return () => controller.abort()
  }, [trackerId, rowId, task])

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [onClose])

  const submit = async (text: string, mentions: string[]) => {
    setBusy(true)
    setError('')
    try {
      if (task) {
        await addTaskComment(task.id, text)
        await onTaskComment()
      } else {
        const { comment } = await trackerApi.addComment(trackerId, rowId, { text, mentions, columnId })
        onCellComment(comment)
      }
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not save. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={box}
      className="trk-cell-comment"
      role="dialog"
      aria-label={`Comment on ${columnName}`}
      style={{ top: place.top, left: place.left }}
    >
      <div className="trk-cell-comment-head">
        <strong>
          <MessageSquare size={13} aria-hidden="true" /> {columnName}
        </strong>
        <button type="button" aria-label="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {task && (
        <p className="trk-muted-text">
          Saved in the {task.kind}’s Comments: <b>{task.title}</b>
        </p>
      )}
      {entries.length > 0 && (
        <ol className="trk-cell-comment-list">
          {entries.slice(-6).map(entry => (
            <li key={`${entry.source}:${entry.id}`}>
              <span className="trk-cell-tip-who">
                <strong>{entry.author}</strong>
                <time dateTime={entry.at}>{niceTime(entry.at)}</time>
              </span>
              <span>{tipText(entry.text)}</span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="trk-field-error">{error}</p>}
      <CommentBox
        people={task ? [] : people}
        submitLabel="Comment"
        busy={busy}
        onCancel={onClose}
        onSubmit={(text, mentions) => void submit(text, mentions)}
      />
      <p className="trk-muted-text">
        {task ? 'Open the task to see all its comments.' : 'Edit or delete it from the row’s Comments.'}
      </p>
    </div>
  )
}
