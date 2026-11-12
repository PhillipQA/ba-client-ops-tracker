import { useState } from 'react'
import { Dialog } from '../../shared/ui'
import { confirmMatches } from './closeSubtasks'

export type CloseWithSubtasksRequest = {
  taskTitle: string
  /** The closed status chosen for the task (Resolved, Closed…). */
  status: string
  subtasks: string[]
  word: string
  answer: (confirmed: boolean) => void
}

/**
 * Asks before closing a task that has open subtasks: they close with it. The person types the word shown, so the
 * subtasks are not closed by a stray click.
 */
export default function CloseWithSubtasksDialog({ request }: { request: CloseWithSubtasksRequest }) {
  const [typed, setTyped] = useState('')
  const count = request.subtasks.length
  const plural = count === 1 ? 'subtask' : 'subtasks'
  const ready = confirmMatches(typed, request.word)
  return (
    <Dialog
      title={`Close task with ${count} open ${plural}?`}
      onClose={() => request.answer(false)}
      className="close-subtasks-dialog"
    >
      <form
        className="close-subtasks-body"
        onSubmit={event => {
          event.preventDefault()
          if (ready) request.answer(true)
        }}
      >
        <p>
          “{request.taskTitle}” has {count} open {plural}. Setting it to <strong>{request.status}</strong> will also
          close {count === 1 ? 'it' : 'all of them'}:
        </p>
        <ul>
          {request.subtasks.slice(0, 8).map((title, index) => (
            <li key={`${index}:${title}`}>{title}</li>
          ))}
          {count > 8 && <li>and {count - 8} more</li>}
        </ul>
        <label>
          Type <strong>{request.word}</strong> to confirm
          <input
            autoFocus
            value={typed}
            autoComplete="off"
            spellCheck={false}
            aria-label={`Type ${request.word} to confirm`}
            onChange={event => setTyped(event.target.value)}
          />
        </label>
        <div className="close-subtasks-actions">
          <button type="button" className="secondary" onClick={() => request.answer(false)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready}>
            Close task and {count} {plural}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
