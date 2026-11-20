/**
 * The Project column's chip and the project menu it opens, also used by "Set project" for the selected rows. Only the
 * tracker's own projects are offered. Moving a task moves its subtasks; a completed project can take existing tasks
 * (older sheets keep work there) but not a new one.
 */
import { useMemo, useState, type RefObject } from 'react'
import { Check, ChevronDown, Lock, Search, Star } from 'lucide-react'
import { Popover } from './trackerUi'
import type { RowProjectChoice, RowProjectView } from './trackerProjects'

/** Moves tasks (with their subtasks) to a project. Throws when it could not be saved. */
export type MoveTasks = (
  taskIds: string[],
  projectId: string,
) => Promise<{ tasks: number; subtasks: number; skipped: number }>

/** The chip in a Project column cell. */
export function ProjectChip({
  view,
  name,
  canChange,
  onOpen,
}: {
  view: RowProjectView
  name: string
  canChange: boolean
  onOpen: (element: HTMLElement) => void
}) {
  if (view.kind === 'subtask') {
    const parent = view.parentTitle ? ` “${view.parentTitle}”` : ''
    return (
      <span className="trk-project-chip locked" title={`A subtask follows its task${parent}. Move the task instead.`}>
        <Lock size={11} aria-hidden="true" />
        <span className="trk-project-name">{name || 'Follows its task'}</span>
      </span>
    )
  }
  const auto = view.kind === 'none'
  const label = name || 'No project'
  const goesTo = name || 'the tracker’s default project'
  const why = 'from the Contract number column, else the ★ default'
  const title = auto
    ? `No task yet: its task goes to ${goesTo} (${why}).${canChange ? ' Click to pick another project.' : ''}`
    : `Project: ${label}.${canChange ? ' Click to move this task and its subtasks.' : ''}`
  if (!canChange)
    return (
      <span className={`trk-project-chip${auto ? ' auto' : ''}`} title={title}>
        <span className="trk-project-name">{label}</span>
        {auto && <small>auto</small>}
      </span>
    )
  return (
    <button
      type="button"
      className={`trk-project-chip${auto ? ' auto' : ''}`}
      title={title}
      aria-label={auto ? `Choose a project for this row (now ${label}, automatic)` : `Change project (now ${label})`}
      onClick={event => {
        event.stopPropagation()
        onOpen(event.currentTarget)
      }}
    >
      <span className="trk-project-name">{label}</span>
      {auto && <small>auto</small>}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  )
}

/**
 * The tracker's projects to pick from. `newTask`: the pick makes a new task, so completed projects are not offered.
 * With `confirmLabel` the pick is shown with `summary` and confirmed with a button; without it the pick is applied at
 * once.
 */
export function ProjectMenu(props: {
  anchor: RefObject<HTMLElement | null>
  heading: string
  choices: RowProjectChoice[]
  currentId?: string
  newTask?: boolean
  note?: string
  confirmLabel?: (choice: RowProjectChoice) => string
  summary?: (choice: RowProjectChoice) => string[]
  onPick: (choice: RowProjectChoice) => Promise<void> | void
  onLinkMore?: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<RowProjectChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return props.choices.filter(choice =>
      words.every(word => `${choice.name} ${choice.contractNumber} ${choice.clientName}`.toLowerCase().includes(word)),
    )
  }, [props.choices, query])
  const apply = async (choice: RowProjectChoice) => {
    setBusy(true)
    setError('')
    try {
      await props.onPick(choice)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
      setBusy(false)
    }
  }
  const choose = (choice: RowProjectChoice) => {
    if (props.confirmLabel) {
      setPicked(choice)
      setError('')
    } else void apply(choice)
  }
  return (
    <Popover
      anchor={props.anchor}
      onClose={props.onClose}
      className="trk-picker wide trk-project-pop"
      label={props.heading}
      minWidth={360}
    >
      <div className="trk-work-head">
        <strong>{props.heading}</strong>
        {props.note && <small>{props.note}</small>}
      </div>
      <label className="trk-picker-find">
        <Search size={14} aria-hidden="true" />
        <input
          autoFocus
          placeholder="Type a project, contract number or client"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="Find a project"
        />
      </label>
      <div className="trk-picker-list">
        {shown.map(choice => {
          const blocked = Boolean(props.newTask && choice.completed)
          const current = choice.id === props.currentId
          const on = picked ? picked.id === choice.id : current
          return (
            <button
              type="button"
              key={choice.id}
              data-item
              className={on ? 'selected' : undefined}
              disabled={busy || blocked || (current && !props.newTask)}
              aria-pressed={on}
              title={
                blocked
                  ? 'Completed: it keeps its tasks but takes no new ones.'
                  : current && !props.newTask
                    ? 'Already in this project'
                    : undefined
              }
              onClick={() => choose(choice)}
            >
              <span className="trk-task-line">
                <strong className="trk-project-option">
                  {choice.name}
                  {choice.isDefault && (
                    <span className="trk-project-default" title="The tracker's default project">
                      <Star size={11} aria-hidden="true" /> default
                    </span>
                  )}
                  {choice.completed && <span className="trk-project-done">Completed</span>}
                </strong>
                <small>{[choice.contractNumber, choice.clientName].filter(Boolean).join(' · ') || ' '}</small>
              </span>
              {current && <Check size={14} aria-label="Current project" />}
            </button>
          )
        })}
        {!shown.length && (
          <p className="trk-picker-empty">
            {props.choices.length ? 'No project of this tracker matches.' : 'This tracker has no projects yet.'}
          </p>
        )}
      </div>
      {picked && props.confirmLabel && (
        <div className="trk-project-confirm">
          {(props.summary?.(picked) || []).map(line => (
            <p key={line}>{line}</p>
          ))}
          <div className="k-dialog-actions">
            <span className="trk-spacer" />
            <button type="button" className="trk-button" disabled={busy} onClick={() => setPicked(null)}>
              Back
            </button>
            <button type="button" className="trk-button primary" disabled={busy} onClick={() => void apply(picked)}>
              {busy ? 'Moving…' : props.confirmLabel(picked)}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="trk-field-error" role="alert">
          {error}
        </p>
      )}
      {props.onLinkMore && (
        <button
          type="button"
          className="trk-picker-clear"
          onClick={() => {
            props.onClose()
            props.onLinkMore!()
          }}
        >
          Link another project to this tracker…
        </button>
      )}
    </Popover>
  )
}
