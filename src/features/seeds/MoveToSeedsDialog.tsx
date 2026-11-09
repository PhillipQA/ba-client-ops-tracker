import { useMemo, useState, type FormEvent } from 'react'
import { ArrowRight, Sprout } from 'lucide-react'
import type { Client, Project, WorkItem } from '../../shared/types'
import { Dialog } from '../../shared/ui'
import { SearchSelect } from '../../shared/ui/SearchSelect'
import { projectTasksToMove, seedsTargetProblem } from './moveToSeeds'
import './seeds.css'

export type MoveRequest = { taskIds: string[]; projectId: string; seedsTaskId?: string; trackers: boolean }
export type MoveOutcome = { moved: number; subtasks: number; skipped: { title: string; reason: string }[] }

/**
 * Moves Before Seeds work into a Seeds project: one task (from its editor), or the tasks of a Before Seeds project
 * (from Projects). The work itself moves, with its subtasks and everything on it; nothing is copied.
 */
export default function MoveToSeedsDialog({
  items,
  projects,
  clients,
  taskId,
  fromProjectId,
  isClosed,
  onMove,
  onClose,
}: {
  items: WorkItem[]
  projects: Project[]
  clients: Client[]
  /** One task to move (from its editor)… */
  taskId?: string
  /** …or the tasks of this Before Seeds project. */
  fromProjectId?: string
  isClosed: (status: string) => boolean
  onMove: (request: MoveRequest) => Promise<MoveOutcome>
  onClose: () => void
}) {
  const task = taskId ? items.find(item => item.id === taskId) : undefined
  const from = projects.find(project => project.id === (fromProjectId || task?.projectId))
  const clientName = (id?: string) => clients.find(client => client.id === id)?.name || ''
  const targets = useMemo(
    () =>
      projects
        .filter(project => !seedsTargetProblem(project))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })),
    [projects],
  )
  const [projectId, setProjectId] = useState('')
  const [seedsTaskId, setSeedsTaskId] = useState('')
  const candidates = useMemo(
    () => (fromProjectId ? projectTasksToMove(items, fromProjectId) : task ? [task] : []),
    [items, fromProjectId, task],
  )
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.filter(item => !item.archived).map(item => item.id)),
  )
  const [trackers, setTrackers] = useState(Boolean(fromProjectId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null)
  const target = targets.find(project => project.id === projectId)
  const chosen = candidates.filter(item => picked.has(item.id) && !item.archived)
  const subtaskCount = items.filter(
    item => item.parentTaskId && chosen.some(top => top.id === item.parentTaskId),
  ).length
  const seedsTasks = (target?.seedsTasks || []).filter(option => !option.archived)
  const movable = candidates.filter(item => !item.archived)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!target) return setError('Choose the Seeds project.')
    if (!chosen.length) return setError('Tick at least one task to move.')
    setBusy(true)
    setError('')
    try {
      setOutcome(
        await onMove({
          taskIds: chosen.map(item => item.id),
          projectId: target.id,
          seedsTaskId: seedsTaskId || undefined,
          trackers,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The work could not be moved.')
    } finally {
      setBusy(false)
    }
  }

  if (outcome)
    return (
      <Dialog title="Moved to Seeds" eyebrow="Seeds" onClose={onClose}>
        <div className="seeds-move">
          <p>
            <strong>
              {outcome.moved} task{outcome.moved === 1 ? '' : 's'}
            </strong>{' '}
            and {outcome.subtasks} subtask{outcome.subtasks === 1 ? '' : 's'} are now in <strong>{target?.name}</strong>
            {target?.clientId ? ` (${clientName(target.clientId)})` : ''}.
          </p>
          {outcome.skipped.length > 0 && (
            <ul className="seeds-move-skipped">
              {outcome.skipped.map(skip => (
                <li key={skip.title}>
                  {skip.title}: {skip.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="k-dialog-actions">
            <span className="seeds-move-spacer" />
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Dialog>
    )

  return (
    <Dialog title="Move to Seeds" eyebrow="Seeds" onClose={onClose} busy={busy} size="medium">
      <form className="seeds-move" onSubmit={event => void submit(event)}>
        <p className="seeds-move-intro">
          <Sprout size={16} aria-hidden="true" />
          <span>
            {task ? (
              <>
                <strong>{task.title}</strong> moves
              </>
            ) : (
              <>
                Tasks of <strong>{from?.name || 'this project'}</strong> move
              </>
            )}{' '}
            to a Seeds project and its client, with their subtasks, comments, files, linked emails, time and tracker
            rows. Nothing is copied.
          </span>
        </p>
        <fieldset className="form-grid" disabled={busy}>
          <label className="span-2">
            Seeds project
            <SearchSelect
              value={projectId}
              onChange={value => {
                setProjectId(value)
                setSeedsTaskId('')
              }}
              placeholder="Type a project, contract number or client"
              empty="No open Seeds project matches"
              choices={[
                { value: '', label: 'Choose the Seeds project' },
                ...targets.map(project => ({
                  value: project.id,
                  label: project.name,
                  hint: [project.contractNumber, clientName(project.clientId)].filter(Boolean).join(' · '),
                })),
              ]}
            />
          </label>
          {task && seedsTasks.length > 0 && (
            <label className="span-2">
              Seeds task
              <select value={seedsTaskId} onChange={event => setSeedsTaskId(event.target.value)}>
                <option value="">Match by name (or none)</option>
                {seedsTasks.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>

        {fromProjectId && (
          <fieldset className="seeds-move-tasks" disabled={busy}>
            <legend>
              Tasks ({chosen.length} of {movable.length})
              {movable.length > 1 && (
                <button
                  type="button"
                  className="seeds-move-link"
                  onClick={() =>
                    setPicked(chosen.length === movable.length ? new Set() : new Set(movable.map(item => item.id)))
                  }
                >
                  {chosen.length === movable.length ? 'Untick all' : 'Tick all'}
                </button>
              )}
            </legend>
            {!candidates.length && <p className="seeds-move-muted">This project has no tasks.</p>}
            <div className="seeds-move-list">
              {candidates.map(item => {
                const subs = items.filter(sub => sub.parentTaskId === item.id).length
                return (
                  <label key={item.id} className={item.archived ? 'off' : undefined}>
                    <input
                      type="checkbox"
                      disabled={item.archived}
                      checked={picked.has(item.id) && !item.archived}
                      onChange={() => {
                        const next = new Set(picked)
                        if (next.has(item.id)) next.delete(item.id)
                        else next.add(item.id)
                        setPicked(next)
                      }}
                    />
                    <span>{item.title}</span>
                    <small>
                      {[
                        subs ? `${subs} subtask${subs === 1 ? '' : 's'}` : '',
                        item.archived ? 'Archived: reopen to move' : isClosed(item.status) ? item.status : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </label>
                )
              })}
            </div>
            <label className="seeds-move-check">
              <input type="checkbox" checked={trackers} onChange={event => setTrackers(event.target.checked)} />
              Also add the Seeds project to trackers on {from?.name || 'this project'}, as their default project
            </label>
          </fieldset>
        )}

        {target && chosen.length > 0 && (
          <p className="seeds-move-summary">
            {from?.name || 'Before Seeds'} <ArrowRight size={14} aria-hidden="true" /> <strong>{target.name}</strong>
            {target.clientId ? ` · ${clientName(target.clientId)}` : ''}: {chosen.length} task
            {chosen.length === 1 ? '' : 's'} and {subtaskCount} subtask{subtaskCount === 1 ? '' : 's'}.
          </p>
        )}
        {error && (
          <p className="seeds-move-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <span className="seeds-move-spacer" />
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !target || !chosen.length}>
            {busy ? 'Moving…' : 'Move to Seeds'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
