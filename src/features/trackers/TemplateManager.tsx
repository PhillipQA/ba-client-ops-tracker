// Tracker templates the account keeps: list them, change their columns, hide or reset the built-in ones, and save a
// tracker's columns as a template. Trackers already made from a template keep their own columns.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, LayoutTemplate, Lock, Plus, Trash2, Users } from 'lucide-react'
import {
  COLUMN_TYPES,
  OPTION_COLORS,
  normalizeColumns,
  randomId,
  TRACKER_LIMITS,
  type ColumnType,
  type SelectOption,
  type Tracker,
  type TrackerColumn,
} from './trackerModel'
import {
  columnsForTemplate,
  gitTemplates,
  savedChoiceId,
  TEMPLATE_LIMITS,
  templateChoices,
  type SavedTemplate,
  type TemplateChoice,
} from './trackerTemplates'
import { TemplateApiError, templateApi, type TemplateBody } from './trackerApi'
import { ColumnIcon, Dialog, Notice } from './trackerUi'
import { keepsStepTasks } from './stepTasks'
import { emptyGitGeneration, normalizeGitGeneration, type GitGeneration } from './gitGeneration'
import { GitTemplateRules } from './GitTemplateRules'
import { starterGitTemplate } from './gitStarter'

/** The account's templates. Before the database upgrade there are none, and the built-in ones are offered as before. */
export function useTrackerTemplates() {
  const [saved, setSaved] = useState<SavedTemplate[]>([])
  const [missing, setMissing] = useState(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await templateApi.list(signal)
      setSaved(result.templates)
      setMissing(false)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return
      if (error instanceof TemplateApiError && error.body.needsUpgrade) setMissing(true)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  return { saved, setSaved, missing, reload: load }
}

const upgradeNote = 'Changing templates is unavailable right now. Ask your administrator to check the database.'
const errorText = (error: unknown) =>
  error instanceof TemplateApiError && error.body.needsUpgrade
    ? upgradeNote
    : error instanceof Error
      ? error.message
      : 'That did not work. Try again.'

/** Saves a template: a built-in one the first time it changes becomes the account's copy. */
async function store(choice: TemplateChoice | null, body: TemplateBody): Promise<SavedTemplate> {
  if (choice?.saved)
    return (await templateApi.update(choice.saved.id, { ...body, revision: choice.saved.revision })).template
  if (choice?.builtIn) return (await templateApi.create({ ...body, templateKey: choice.id, shared: true })).template
  return (await templateApi.create(body)).template
}

/** Who may change a template: its maker for private ones, Administrators for shared and built-in ones. */
const canChange = (choice: TemplateChoice, isAdmin: boolean) =>
  choice.id !== 'blank' && (choice.saved ? choice.saved.canEdit : choice.builtIn ? isAdmin : false)

// --- The list ---

export function TemplatesDialog({
  saved,
  isAdmin,
  canCreate,
  missing,
  onSaved,
  onClose,
}: {
  saved: SavedTemplate[]
  isAdmin: boolean
  canCreate: boolean
  missing: boolean
  onSaved: (templates: SavedTemplate[]) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<TemplateChoice | 'new' | 'new-git' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const choices = templateChoices(saved, isAdmin).filter(choice => choice.id !== 'blank')
  // GIT templates, for GIT Trackers: always the account's own (there is no built-in one).
  const gitChoices: TemplateChoice[] = gitTemplates(saved, isAdmin).map(item => ({
    id: savedChoiceId(item),
    name: item.name,
    about: item.about,
    columns: item.columns,
    builtIn: false,
    saved: item,
  }))
  const replace = (template: SavedTemplate) => onSaved([...saved.filter(item => item.id !== template.id), template])
  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await job()
    } catch (problem) {
      setError(errorText(problem))
    } finally {
      setBusy(false)
    }
  }
  const hide = (choice: TemplateChoice, hidden: boolean) =>
    run(async () => {
      if (choice.saved)
        replace((await templateApi.update(choice.saved.id, { hidden, revision: choice.saved.revision })).template)
      else
        replace(
          (
            await templateApi.create({
              name: choice.name,
              about: choice.about,
              columns: choice.columns,
              templateKey: choice.id,
              shared: true,
              hidden,
            })
          ).template,
        )
    })
  const remove = (choice: TemplateChoice) => {
    const saved_ = choice.saved
    if (!saved_) return
    const reset = Boolean(saved_.templateKey)
    if (
      !window.confirm(
        reset
          ? `Reset “${choice.name}” to the built-in columns for everyone? Trackers already made from it keep theirs.`
          : `Delete the template “${choice.name}”? Trackers already made from it keep their columns.`,
      )
    )
      return
    void run(async () => {
      await templateApi.remove(saved_.id)
      onSaved(saved.filter(item => item.id !== saved_.id))
    })
  }

  if (editing)
    return (
      <TemplateEditor
        choice={editing === 'new' || editing === 'new-git' ? null : editing}
        git={editing === 'new-git'}
        isAdmin={isAdmin}
        onClose={() => setEditing(null)}
        onSaved={template => {
          replace(template)
          setEditing(null)
        }}
      />
    )
  return (
    <Dialog title="Tracker templates" eyebrow="Trackers" onClose={onClose} size="medium" busy={busy}>
      <div className="trk-tpl-list">
        {missing && <Notice kind="info">{upgradeNote}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <p className="trk-muted-text">
          The columns new trackers start with. Changing a template does not change trackers already made from it.
          {isAdmin ? ' Built-in and shared templates are for everyone; only Administrators change them.' : ''}
        </p>
        {[...choices, ...gitChoices].map((choice, at) => {
          const changeable = canChange(choice, isAdmin) && !missing
          const firstGit = at === choices.length
          return (
            <Fragment key={choice.id}>
              {firstGit && (
                <h3 className="trk-tpl-section">
                  GIT templates <small>for GIT Trackers: what each GitLab or GitHub ticket makes</small>
                </h3>
              )}
              <div className={`trk-tpl-row${choice.saved?.hidden ? ' is-hidden' : ''}`}>
                <LayoutTemplate size={16} aria-hidden="true" />
                <div className="trk-tpl-text">
                  <strong>{choice.name}</strong>
                  <span>{choice.about}</span>
                  <small>
                    {plainTags(choice).join(' · ')} · {choice.columns.length} columns
                  </small>
                </div>
                <div className="trk-tpl-actions">
                  {changeable && (
                    <button type="button" className="trk-button" disabled={busy} onClick={() => setEditing(choice)}>
                      Edit
                    </button>
                  )}
                  {isAdmin && !missing && (choice.builtIn || choice.saved?.shared) && (
                    <button
                      type="button"
                      className="trk-button"
                      disabled={busy}
                      onClick={() => void hide(choice, !choice.saved?.hidden)}
                    >
                      {choice.saved?.hidden ? 'Show' : 'Hide'}
                    </button>
                  )}
                  {changeable && choice.saved && (
                    <button type="button" className="trk-button" disabled={busy} onClick={() => remove(choice)}>
                      {choice.saved.templateKey ? 'Reset' : 'Delete'}
                    </button>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
        <div className="k-dialog-actions">
          {canCreate && !missing && (
            <button type="button" className="trk-button" disabled={busy} onClick={() => setEditing('new')}>
              <Plus size={14} aria-hidden="true" /> New template
            </button>
          )}
          {canCreate && !missing && (
            <button type="button" className="trk-button" disabled={busy} onClick={() => setEditing('new-git')}>
              <Plus size={14} aria-hidden="true" /> New GIT template
            </button>
          )}
          <span className="trk-spacer" />
          <button type="button" className="trk-button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function plainTags(choice: TemplateChoice) {
  const tags: string[] = []
  if (choice.builtIn) tags.push(choice.saved ? 'Built-in, changed' : 'Built-in')
  else tags.push(choice.saved?.shared ? 'For everyone' : 'Only you')
  if (choice.saved?.kind === 'git') tags.push('GIT')
  if (choice.saved?.hidden) tags.push('Hidden')
  return tags
}

// --- Changing a template's columns ---

/** `id`: the column's id, kept while the template is edited (a GIT template's rules refer to columns by id). */
type Draft = { key: string; id: string; name: string; type: ColumnType; choices: string; original?: TrackerColumn }
const LISTED_TYPES = COLUMN_TYPES.filter(item => item.type !== 'formula')
const hasChoices = (type: ColumnType) => type === 'select' || type === 'multiselect'
const newDraft = (): Draft => ({ key: randomId('d_'), id: randomId('c_'), name: '', type: 'text', choices: '' })
const toDraft = (column: TrackerColumn): Draft => ({
  key: randomId('d_'),
  id: column.id || randomId('c_'),
  name: column.name,
  type: column.type,
  choices: (column.options || []).map(option => option.label).join(', '),
  original: column,
})

/** The drafts as columns: an unchanged column keeps its settings; choices keep their colours by label. */
function draftColumns(drafts: Draft[], doneKey: string): TrackerColumn[] {
  return drafts.map((draft, index) => {
    const same = draft.original && draft.original.type === draft.type ? draft.original : undefined
    const column: TrackerColumn = {
      ...(same || {}),
      id: same?.id || draft.id,
      name: draft.name.trim(),
      type: draft.type,
    }
    delete column.autoDone
    if (hasChoices(draft.type)) {
      const before = new Map((same?.options || []).map(option => [option.label.toLowerCase(), option]))
      const labels = [
        ...new Set(
          draft.choices
            .split(/[,\n]/)
            .map(label => label.trim())
            .filter(Boolean),
        ),
      ]
      column.options = labels.map(
        (label, at): SelectOption =>
          before.get(label.toLowerCase()) || {
            id: randomId('o_'),
            label,
            color: OPTION_COLORS[(at + index) % OPTION_COLORS.length],
          },
      )
    } else delete column.options
    if (draft.key === doneKey) {
      if (draft.type === 'checkbox') column.autoDone = {}
      else if (same?.autoDone) column.autoDone = same.autoDone
    }
    return column
  })
}

export function TemplateEditor({
  choice,
  isAdmin,
  git: newGit = false,
  initialColumns,
  initialStepTasks,
  onClose,
  onSaved,
}: {
  /** The template to change; null for a new one. */
  choice: TemplateChoice | null
  isAdmin: boolean
  /** A new GIT template (an existing one is known from its kind). */
  git?: boolean
  /** A new template's first columns, such as a tracker's. */
  initialColumns?: TrackerColumn[]
  /** A new template's first setting for tasks, such as the tracker's. */
  initialStepTasks?: boolean
  onClose: () => void
  onSaved: (template: SavedTemplate) => void
}) {
  // A GIT template: its rules say what each ticket makes. A new one starts from the usual Ticket / Development / QA.
  const git = choice ? choice.saved?.kind === 'git' : newGit
  const [starter] = useState(() => (git && !choice ? starterGitTemplate() : null))
  const start = choice
    ? (choice.columns as TrackerColumn[])
    : starter?.columns || initialColumns || [{ id: '', name: 'Name', type: 'text' }]
  const [generation, setGeneration] = useState<GitGeneration>(
    () => choice?.saved?.generation || starter?.generation || emptyGitGeneration(),
  )
  const [name, setName] = useState(choice?.name || '')
  const [about, setAbout] = useState(choice?.about || '')
  const [shared, setShared] = useState(Boolean(choice?.saved?.shared))
  const [stepTasks, setStepTasks] = useState(Boolean(choice?.stepTasks ?? initialStepTasks))
  const [drafts, setDrafts] = useState<Draft[]>(() => start.map(toDraft))
  const [doneKey, setDoneKey] = useState(() => {
    const at = start.findIndex(column => column.autoDone)
    return at >= 0 ? drafts[at]?.key || '' : ''
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const builtIn = Boolean(choice?.builtIn)
  // The columns as they are being edited, for the GIT rules (ids stay the same while editing).
  const liveColumns = useMemo(() => (git ? draftColumns(drafts, doneKey) : []), [git, drafts, doneKey])
  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts(list => list.map(item => (item.key === key ? { ...item, ...patch } : item)))
  const move = (index: number, by: number) =>
    setDrafts(list => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item)
      return next
    })
  const doneChoices = drafts.filter(
    draft =>
      draft.name.trim() &&
      (draft.type === 'checkbox' || (draft.original?.autoDone && draft.original.type === draft.type)),
  )

  const save = async () => {
    setError('')
    if (!name.trim()) return setError('Enter a name for the template.')
    const empty = drafts.find(draft => !draft.name.trim())
    if (empty) return setError('Every column needs a name.')
    const noChoices = drafts.find(draft => hasChoices(draft.type) && !draft.choices.trim())
    if (noChoices) return setError(`Add the choices for “${noChoices.name}”, separated by commas.`)
    let columns: TrackerColumn[]
    try {
      columns = normalizeColumns(draftColumns(drafts, doneKey))
    } catch (problem) {
      return setError(problem instanceof Error ? problem.message : 'Check the columns.')
    }
    if (git) {
      const problems = normalizeGitGeneration(generation, columns).errors
      if (problems.length) return setError(`Fix the rules first: ${problems[0]}`)
    }
    setBusy(true)
    try {
      onSaved(
        await store(choice, {
          name: name.trim(),
          about: about.trim(),
          columns,
          shared: builtIn || (isAdmin && shared),
          ...(git ? { generation, ...(choice ? {} : { kind: 'git' as const }) } : { stepTasks }),
        }),
      )
    } catch (problem) {
      setError(errorText(problem))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={choice ? `Edit “${choice.name}”` : git ? 'New GIT template' : 'New template'}
      eyebrow={git ? 'GIT template' : 'Tracker template'}
      onClose={onClose}
      wide
      busy={busy}
    >
      <form
        className="trk-tpl-editor"
        onSubmit={event => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="trk-tpl-head">
          <label className="trk-field-block">
            Name
            <input
              value={name}
              maxLength={TEMPLATE_LIMITS.name}
              required
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="trk-field-block">
            What it is for
            <input value={about} maxLength={TEMPLATE_LIMITS.about} onChange={event => setAbout(event.target.value)} />
          </label>
        </div>
        {builtIn ? (
          <p className="trk-muted-text">
            A built-in template, for everyone. Your changes replace it for the account; Reset brings the original back.
          </p>
        ) : isAdmin ? (
          <label className="trk-checkline">
            <input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} /> Everyone in
            the account can start trackers from it
          </label>
        ) : (
          <p className="trk-muted-text">
            Only you see this template. An Administrator can make templates for everyone.
          </p>
        )}

        <div className="trk-tpl-columns" role="table" aria-label="Columns">
          <div className="trk-tpl-col head" role="row">
            <span role="columnheader">#</span>
            <span role="columnheader">Column</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Choices</span>
            <span role="columnheader">
              <span className="trk-visually-hidden">Move or remove</span>
            </span>
          </div>
          {drafts.map((draft, index) => (
            <div className="trk-tpl-col" role="row" key={draft.key}>
              <span role="cell" className="trk-muted">
                {index + 1}
              </span>
              <span role="cell">
                <input
                  value={draft.name}
                  maxLength={TRACKER_LIMITS.columnName}
                  aria-label={`Column ${index + 1} name`}
                  onChange={event => set(draft.key, { name: event.target.value })}
                />
              </span>
              <span role="cell" className="trk-tpl-type">
                <ColumnIcon type={draft.type} />
                <select
                  value={draft.type}
                  aria-label={`Column ${index + 1} type`}
                  onChange={event => set(draft.key, { type: event.target.value as ColumnType })}
                >
                  {(draft.type === 'formula' ? COLUMN_TYPES.filter(item => item.type === 'formula') : []).map(item => (
                    <option key={item.type} value={item.type}>
                      {item.label}
                    </option>
                  ))}
                  {LISTED_TYPES.map(item => (
                    <option key={item.type} value={item.type}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </span>
              <span role="cell">
                {hasChoices(draft.type) ? (
                  <input
                    value={draft.choices}
                    placeholder="Choice one, Choice two"
                    aria-label={`Column ${index + 1} choices`}
                    onChange={event => set(draft.key, { choices: event.target.value })}
                  />
                ) : (
                  <span className="trk-muted">—</span>
                )}
              </span>
              <span role="cell" className="trk-tpl-tools">
                <button
                  type="button"
                  className="trk-icon-button small"
                  aria-label={`Move ${draft.name || 'column'} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="trk-icon-button small"
                  aria-label={`Move ${draft.name || 'column'} down`}
                  disabled={index === drafts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="trk-icon-button small"
                  aria-label={`Remove ${draft.name || 'column'}`}
                  disabled={drafts.length === 1}
                  onClick={() => setDrafts(list => list.filter(item => item.key !== draft.key))}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
        <div className="trk-tpl-under">
          <button
            type="button"
            className="trk-button"
            disabled={drafts.length >= TRACKER_LIMITS.columns}
            onClick={() => setDrafts(list => [...list, newDraft()])}
          >
            <Plus size={14} aria-hidden="true" /> Add a column
          </button>
          <label className="trk-tpl-done">
            Ticks itself when the row’s tasks are done
            <select value={doneKey} onChange={event => setDoneKey(event.target.value)}>
              <option value="">No column</option>
              {doneChoices.map(draft => (
                <option key={draft.key} value={draft.key}>
                  {draft.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {git ? (
          <GitTemplateRules columns={liveColumns} value={generation} onChange={setGeneration} />
        ) : (
          <>
            <label className="trk-checkline">
              <input type="checkbox" checked={stepTasks} onChange={event => setStepTasks(event.target.checked)} /> Each
              row becomes a task, and each Checkbox column a subtask of it
              <small>(made as soon as a row has a name; ticking a box completes its subtask)</small>
            </label>
            <p className="trk-muted-text">
              The first column names each row and holds the row’s task; the other cells can each hold one subtask of it.
            </p>
          </>
        )}
        <p className="trk-muted-text">Trackers already made from this template keep their own columns and settings.</p>
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="trk-button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// --- A tracker's columns as a template ---

export function SaveAsTemplateDialog({
  tracker,
  isAdmin,
  onClose,
  onDone,
}: {
  tracker: Tracker
  isAdmin: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const { saved, missing } = useTrackerTemplates()
  const choices = templateChoices(saved, isAdmin).filter(choice => canChange(choice, isAdmin))
  const [target, setTarget] = useState('')
  const [name, setName] = useState(tracker.name)
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const columns = columnsForTemplate(tracker.columns)
  const chosen = choices.find(choice => choice.id === target) || null
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const template = await store(
        chosen,
        chosen
          ? { columns }
          : {
              name: name.trim(),
              about: `Made from the tracker “${tracker.name}”.`,
              columns,
              shared: isAdmin && shared,
              stepTasks: keepsStepTasks(tracker),
            },
      )
      onDone(chosen ? `“${template.name}” now has this tracker’s columns.` : `Saved the template “${template.name}”.`)
    } catch (problem) {
      setError(errorText(problem))
      setBusy(false)
    }
  }
  return (
    <Dialog title="Save as template" eyebrow={tracker.name} onClose={onClose} busy={busy}>
      <form
        className="trk-tpl-save"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        {missing && <Notice kind="info">{upgradeNote}</Notice>}
        <p className="trk-muted-text">
          Saves this tracker’s {columns.length} columns, with their choices and settings, so new trackers can start with
          them. Rows are not copied.
        </p>
        <label className="trk-field-block">
          Save to
          <select value={target} onChange={event => setTarget(event.target.value)}>
            <option value="">A new template</option>
            {choices.map(choice => (
              <option key={choice.id} value={choice.id}>
                Replace the columns of “{choice.name}”{choice.builtIn ? ' (built-in)' : ''}
              </option>
            ))}
          </select>
        </label>
        {!chosen && (
          <>
            <label className="trk-field-block">
              Template name
              <input
                value={name}
                maxLength={TEMPLATE_LIMITS.name}
                required
                onChange={event => setName(event.target.value)}
              />
            </label>
            {isAdmin ? (
              <label className="trk-checkline">
                <input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} /> Everyone
                in the account can start trackers from it
              </label>
            ) : (
              <p className="trk-muted-text">Only you will see it.</p>
            )}
          </>
        )}
        {chosen && <p className="trk-muted-text">Trackers already made from “{chosen.name}” keep their own columns.</p>}
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="trk-button primary" disabled={busy || missing || (!chosen && !name.trim())}>
            {busy ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** A short label for a template in New tracker. */
export function TemplateTag({ choice }: { choice: TemplateChoice }) {
  if (choice.builtIn) return null
  return choice.saved?.shared ? (
    <em className="trk-tpl-tag">
      <Users size={11} aria-hidden="true" /> Account
    </em>
  ) : (
    <em className="trk-tpl-tag">
      <Lock size={11} aria-hidden="true" /> Yours
    </em>
  )
}
