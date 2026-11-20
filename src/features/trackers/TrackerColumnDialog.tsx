import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import type { ConvertReport } from './trackerApi'
import {
  CONVERTIBLE_TYPES,
  FORMULA_SOURCES,
  canConvertType,
  COLUMN_TYPES,
  formulaFromText,
  formulaToText,
  OPTION_COLORS,
  TRACKER_LIMITS,
  randomId,
  canAutoDone,
  type AutoDone,
  type ColumnGroup,
  type ColumnType,
  type OptionColor,
  type RevealBy,
  type SelectOption,
  type TotalKind,
  type TrackerColumn,
} from './trackerModel'
import { ColumnIcon, Dialog, Pill } from './trackerUi'

export type ColumnDraft = {
  name: string
  type: ColumnType
  options?: SelectOption[]
  revealBy?: RevealBy
  formula?: string
  total?: TotalKind | null
  /** Done when its tasks are done: the setting, or null to turn it off. Left out when unchanged. */
  autoDone?: AutoDone | null
  /** Text columns: show the contract number of the row's project ('contract'), or null to stop. Left out when unchanged. */
  contract?: boolean
  /** Text columns: show the row's project as a chip that moves its task ('project'). Left out when unchanged. */
  project?: boolean
}

type Props = {
  mode: 'add' | 'edit'
  columns: TrackerColumn[]
  column?: TrackerColumn
  onClose: () => void
  onSave: (draft: ColumnDraft) => Promise<void>
  onDelete?: () => Promise<void>
  /** Checks (confirm false) or applies (confirm true) a change of the column's type. */
  onConvert?: (type: ColumnType, confirm: boolean, clearUnfit: boolean) => Promise<ConvertReport>
  /** The connected Sheet's name, when this tracker follows one. */
  sheetName?: string
  /** False when only the tracker's owner or an Administrator may change who can reveal a Secret column. */
  canManageSecrets?: boolean
}

const GROUPS: { id: ColumnGroup; label: string; about: string }[] = [
  { id: 'basic', label: 'Basic', about: 'You type or pick the value.' },
  { id: 'computed', label: 'Calculated', about: 'Worked out from other columns in the same row.' },
  { id: 'connected', label: 'Fills itself', about: 'Read from the task a row is linked to. Nothing is typed in.' },
  { id: 'protected', label: 'Protected', about: 'Encrypted, hidden, and logged whenever it is revealed.' },
]

const nextColor = (count: number): OptionColor => OPTION_COLORS[(count % (OPTION_COLORS.length - 1)) + 1]

export default function TrackerColumnDialog({
  mode,
  columns,
  column,
  onClose,
  onSave,
  onDelete,
  onConvert,
  sheetName,
  canManageSecrets = true,
}: Props) {
  const adding = mode === 'add'
  const [type, setType] = useState<ColumnType>(column?.type || 'text')
  const [name, setName] = useState(column?.name || '')
  const [options, setOptions] = useState<SelectOption[]>(() => (column?.options || []).map(option => ({ ...option })))
  const [revealBy, setRevealBy] = useState<RevealBy>(column?.revealBy || 'editors')
  const [query, setQuery] = useState('')
  const [formula, setFormula] = useState(() => (column?.formula ? formulaToText(column.formula, columns) : ''))
  const [total, setTotal] = useState(Boolean(column?.total))
  const [autoOn, setAutoOn] = useState(Boolean(column?.autoDone))
  const [autoDoneOption, setAutoDoneOption] = useState(column?.autoDone?.done || '')
  const [autoUndoneOption, setAutoUndoneOption] = useState(column?.autoDone?.undone || '')
  const otherAutoDone = columns.find(item => item.id !== column?.id && item.autoDone)
  // Text columns can show the contract number of the row's project (from Seeds), e.g. an "SLSS #" column.
  const [contractOn, setContractOn] = useState(column?.taskField === 'contract')
  const otherContract = columns.find(item => item.id !== column?.id && item.taskField === 'contract')
  // Or the row's project itself, as a chip: picking another project moves the row's task and its subtasks.
  const [projectOn, setProjectOn] = useState(column?.taskField === 'project')
  const otherProject = columns.find(item => item.id !== column?.id && item.taskField === 'project')
  /** When the setting is turned on, an option named like Done is chosen for "Set to", so most people need not pick it. */
  const guessDoneOption = () =>
    options.find(option => /^(done|completed?|closed|resolved|finished)$/i.test(option.label.trim()))?.id || ''
  const formulaInput = useRef<HTMLInputElement>(null)
  const sources = columns.filter(item => item.id !== column?.id && FORMULA_SOURCES.includes(item.type))
  const formulaCheck = type === 'formula' && formula.trim() ? formulaFromText(formula, columns, column?.id || '') : null
  const insertRef = (name: string) => {
    const input = formulaInput.current,
      at = input?.selectionStart ?? formula.length,
      end = input?.selectionEnd ?? at
    const piece = `[${name}]`
    setFormula(formula.slice(0, at) + piece + formula.slice(end))
    setError('')
    window.setTimeout(() => {
      input?.focus()
      input?.setSelectionRange(at + piece.length, at + piece.length)
    }, 0)
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastOption = useRef<HTMLInputElement>(null)
  const info = COLUMN_TYPES.find(item => item.type === type)!
  const converting = !adding && Boolean(column) && type !== column!.type
  const contractAllowed =
    type === 'text' &&
    !converting &&
    (!column?.taskField || column.taskField === 'contract' || column.taskField === 'project')
  const hasOptions = (type === 'select' || type === 'multiselect') && !converting
  const [report, setReport] = useState<Extract<ConvertReport, { applied: false }> | null>(null)
  const autoAllowed = canAutoDone({ type }) && !converting
  const [clearUnfit, setClearUnfit] = useState(false)

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    return COLUMN_TYPES.filter(item => !wanted || `${item.label} ${item.about}`.toLowerCase().includes(wanted))
  }, [query])

  const choose = (next: ColumnType) => {
    setType(next)
    const label = COLUMN_TYPES.find(item => item.type === next)!.label
    // Suggest a name until the person has typed their own.
    if (!name.trim() || COLUMN_TYPES.some(item => item.label === name)) setName(label)
    setError('')
  }
  const setOption = (id: string, patch: Partial<SelectOption>) =>
    setOptions(list => list.map(option => (option.id === id ? { ...option, ...patch } : option)))
  const addOption = (label = '') => {
    setOptions(list =>
      list.length >= TRACKER_LIMITS.optionsPerColumn
        ? list
        : [...list, { id: randomId('o_'), label, color: nextColor(list.length) }],
    )
    window.setTimeout(() => lastOption.current?.focus(), 0)
  }
  const paste = (id: string, text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
    if (lines.length < 2) return false
    setOptions(list => {
      const at = list.findIndex(option => option.id === id)
      const added = lines.slice(1).map((label, i) => ({ id: randomId('o_'), label, color: nextColor(list.length + i) }))
      const next = list.map(option => (option.id === id ? { ...option, label: lines[0] } : option))
      next.splice(at + 1, 0, ...added)
      return next.slice(0, TRACKER_LIMITS.optionsPerColumn)
    })
    return true
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const trimmed = name.trim().replace(/\s+/g, ' ')
    if (!trimmed) return setError('Enter a column name.')
    if (trimmed.length > TRACKER_LIMITS.columnName)
      return setError(`The name can be at most ${TRACKER_LIMITS.columnName} characters.`)
    if (columns.some(other => other.id !== column?.id && other.name.toLowerCase() === trimmed.toLowerCase()))
      return setError(`There is already a column named “${trimmed}”.`)
    if (adding && columns.length >= TRACKER_LIMITS.columns)
      return setError(`A tracker can have at most ${TRACKER_LIMITS.columns} columns.`)
    const cleaned = options.map(option => ({ ...option, label: option.label.trim() })).filter(option => option.label)
    if (new Set(cleaned.map(option => option.label.toLowerCase())).size !== cleaned.length)
      return setError('Two options have the same name.')
    if (type === 'formula' && !converting) {
      const checked = formulaFromText(formula, columns, column?.id || '')
      if (!checked.ok) return setError(checked.error)
    }
    const autoChoices = options.filter(option => option.label.trim())
    if (autoAllowed && autoOn && type === 'select' && !autoChoices.some(option => option.id === autoDoneOption))
      return setError('Choose the option to set when the linked tasks are done.')
    const autoDone: AutoDone | null =
      !autoAllowed || !autoOn
        ? null
        : type === 'checkbox'
          ? {}
          : {
              done: autoDoneOption,
              ...(autoUndoneOption && autoChoices.some(option => option.id === autoUndoneOption)
                ? { undone: autoUndoneOption }
                : {}),
            }
    const autoChanged = JSON.stringify(autoDone) !== JSON.stringify(column?.autoDone ?? null)
    if (converting && onConvert && !report) {
      // First ask what the change would do, and show it before anything is touched.
      setBusy(true)
      setError('')
      try {
        const result = await onConvert(type, false, false)
        if (!result.applied) setReport(result)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The type could not be checked.')
      }
      setBusy(false)
      return
    }
    if (converting && report && report.failed > 0 && !clearUnfit)
      return setError('Tick the box to confirm those values will be cleared, or cancel and fix them first.')
    setBusy(true)
    setError('')
    try {
      const summable = (column?.type || type) === 'number' || (column?.type || type) === 'formula'
      const sameType = {
        name: trimmed,
        type: column?.type || type,
        ...(column?.type === 'select' || column?.type === 'multiselect' ? { options: cleaned } : {}),
        ...(column?.type === 'secret' ? { revealBy } : {}),
        ...(column?.type === 'formula' ? { formula } : {}),
        ...(summable ? { total: total ? column?.total || ('sum' as const) : null } : {}),
        ...(autoChanged ? { autoDone } : {}),
        ...(contractAllowed && contractOn !== (column?.taskField === 'contract') ? { contract: contractOn } : {}),
        ...(contractAllowed && projectOn !== (column?.taskField === 'project') ? { project: projectOn } : {}),
      }
      const renamed =
        column &&
        (trimmed !== column.name ||
          (sameType.options && JSON.stringify(sameType.options) !== JSON.stringify(column.options || [])) ||
          (column.type === 'secret' && revealBy !== (column.revealBy || 'editors')) ||
          (column.type === 'formula' && formula !== formulaToText(column.formula || '', columns)) ||
          (summable && total !== Boolean(column.total)) ||
          autoChanged)
      if (converting && onConvert) {
        if (renamed) await onSave(sameType as ColumnDraft)
        await onConvert(type, true, clearUnfit)
      } else
        await onSave({
          name: trimmed,
          type,
          ...(hasOptions ? { options: cleaned } : {}),
          ...(type === 'secret' ? { revealBy } : {}),
          ...(type === 'formula' ? { formula } : {}),
          ...(type === 'number' || type === 'formula' ? { total: total ? ('sum' as const) : null } : {}),
          ...(autoChanged ? { autoDone } : {}),
          ...(contractAllowed && contractOn ? { contract: true } : {}),
          ...(contractAllowed && projectOn ? { project: true } : {}),
        })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The column could not be saved.')
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!onDelete || busy) return
    const secret = column?.type === 'secret'
    if (
      !window.confirm(
        `Delete the column “${column?.name}”? ${secret ? 'Every value stored in it is permanently erased. ' : 'The values in it are removed from every row. '}This cannot be undone.`,
      )
    )
      return
    setBusy(true)
    setError('')
    try {
      await onDelete()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The column could not be deleted.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={adding ? 'Add a column' : `Edit “${column?.name}”`}
      eyebrow={adding ? 'New column' : 'Column'}
      onClose={onClose}
      wide={adding}
      busy={busy}
    >
      <form className={adding ? 'trk-columns-form' : 'trk-columns-form single'} onSubmit={event => void submit(event)}>
        {adding && (
          <div className="trk-type-list">
            <label className="trk-search">
              <Search size={14} aria-hidden="true" />
              <input
                autoFocus
                placeholder="Search column types"
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="Search column types"
              />
            </label>
            <div className="trk-type-scroll">
              {GROUPS.map(group => {
                const list = shown.filter(item => item.group === group.id)
                if (!list.length) return null
                return (
                  <section key={group.id} aria-label={group.label}>
                    <h3>
                      {group.label}
                      <small>{group.about}</small>
                    </h3>
                    {list.map(item => (
                      <button
                        type="button"
                        key={item.type}
                        className={item.type === type ? 'selected' : ''}
                        aria-pressed={item.type === type}
                        onClick={() => choose(item.type)}
                      >
                        <ColumnIcon type={item.type} size={16} />
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </section>
                )
              })}
              {!shown.length && <p className="trk-muted-text">No column type matches “{query}”.</p>}
            </div>
          </div>
        )}
        <div className="trk-config">
          <div className="trk-config-head">
            <ColumnIcon type={type} size={18} />
            <div>
              <strong>{info.label}</strong>
              <p>{info.about}</p>
            </div>
          </div>
          <label className="trk-field-block">
            Column name
            <input
              value={name}
              onChange={event => {
                setName(event.target.value)
                setError('')
              }}
              maxLength={TRACKER_LIMITS.columnName}
              autoFocus={!adding}
              required
            />
          </label>
          {hasOptions && (
            <fieldset className="trk-options">
              <legend>Options</legend>
              {options.map((option, at) => (
                <div key={option.id} className="trk-option-row">
                  <div className="trk-swatches" role="radiogroup" aria-label={`Colour for ${option.label || 'option'}`}>
                    {OPTION_COLORS.map(color => (
                      <button
                        type="button"
                        key={color}
                        role="radio"
                        aria-checked={option.color === color}
                        aria-label={color}
                        className={`trk-swatch trk-tone-${color}${option.color === color ? ' on' : ''}`}
                        onClick={() => setOption(option.id, { color })}
                      />
                    ))}
                  </div>
                  <input
                    ref={at === options.length - 1 ? lastOption : undefined}
                    value={option.label}
                    aria-label={`Option ${at + 1}`}
                    maxLength={TRACKER_LIMITS.optionLabel}
                    placeholder="Option name"
                    onChange={event => setOption(option.id, { label: event.target.value })}
                    onPaste={event => {
                      if (paste(option.id, event.clipboardData.getData('text'))) event.preventDefault()
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        addOption()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="trk-icon-button small"
                    aria-label={`Remove ${option.label || 'option'}`}
                    onClick={() => setOptions(list => list.filter(item => item.id !== option.id))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <div className="trk-option-actions">
                <button
                  type="button"
                  className="trk-text-button strong"
                  onClick={() => addOption()}
                  disabled={options.length >= TRACKER_LIMITS.optionsPerColumn}
                >
                  <Plus size={13} aria-hidden="true" /> Add option
                </button>
                {options.length > 0 && (
                  <span className="trk-preview" aria-hidden="true">
                    {options
                      .filter(option => option.label.trim())
                      .slice(0, 4)
                      .map(option => (
                        <Pill key={option.id} tone={option.color}>
                          {option.label}
                        </Pill>
                      ))}
                  </span>
                )}
              </div>
              {!adding && <p className="trk-muted-text">Removing an option empties that value wherever it is used.</p>}
            </fieldset>
          )}
          {type === 'formula' && !converting && (
            <fieldset className="trk-options trk-formula">
              <legend>Formula</legend>
              <input
                ref={formulaInput}
                value={formula}
                onChange={event => {
                  setFormula(event.target.value)
                  setError('')
                }}
                placeholder="[Qty] * [Price]"
                aria-label="Formula"
                spellCheck={false}
                autoComplete="off"
              />
              {sources.length > 0 ? (
                <div className="trk-formula-refs" aria-label="Insert a column">
                  {sources.map(item => (
                    <button
                      type="button"
                      key={item.id}
                      className="trk-formula-ref"
                      onClick={() => insertRef(item.name)}
                    >
                      {item.name}
                    </button>
                  ))}
                  {['+', '-', '*', '/', '(', ')'].map(op => (
                    <button
                      type="button"
                      key={op}
                      className="trk-formula-ref op"
                      aria-label={
                        {
                          '+': 'add',
                          '-': 'subtract',
                          '*': 'multiply',
                          '/': 'divide',
                          '(': 'open bracket',
                          ')': 'close bracket',
                        }[op]
                      }
                      onClick={() => {
                        setFormula(value => `${value}${value && !value.endsWith(' ') ? ' ' : ''}${op} `)
                        formulaInput.current?.focus()
                      }}
                    >
                      {op}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="trk-muted-text">
                  Add a Number column first; a formula works out a value from Number and other Calculated columns.
                </p>
              )}
              <p className={formulaCheck && !formulaCheck.ok ? 'trk-field-error' : 'trk-muted-text'}>
                {formulaCheck
                  ? formulaCheck.ok
                    ? 'The formula looks right.'
                    : formulaCheck.error
                  : 'Click a column to add it. Use + to add, - to subtract, * to multiply and / to divide. Brackets work as in Excel.'}
              </p>
            </fieldset>
          )}
          {(type === 'number' || type === 'formula') && !converting && (
            <label className="trk-checkline">
              <input type="checkbox" checked={total} onChange={event => setTotal(event.target.checked)} /> Show a total
              in the totals row (Sum, unless you picked another there)
            </label>
          )}
          {autoAllowed && (
            <fieldset className="trk-options">
              <legend>When the linked tasks are done</legend>
              <label className="trk-checkline">
                <input
                  type="checkbox"
                  checked={autoOn}
                  onChange={event => {
                    setAutoOn(event.target.checked)
                    if (event.target.checked && type === 'select' && !autoDoneOption)
                      setAutoDoneOption(guessDoneOption())
                    setError('')
                  }}
                />{' '}
                {type === 'checkbox'
                  ? 'Tick this automatically when every task and subtask linked to the row is completed'
                  : 'Set this automatically when every task and subtask linked to the row is completed'}
              </label>
              {autoOn && type === 'select' && (
                <>
                  <label className="trk-field-block">
                    Set to
                    <select
                      value={autoDoneOption}
                      onChange={event => {
                        setAutoDoneOption(event.target.value)
                        setError('')
                      }}
                    >
                      <option value="">Choose an option</option>
                      {options
                        .filter(option => option.label.trim())
                        .map(option => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="trk-field-block">
                    If a task is reopened, set it back to
                    <select value={autoUndoneOption} onChange={event => setAutoUndoneOption(event.target.value)}>
                      <option value="">(empty)</option>
                      {options
                        .filter(option => option.label.trim() && option.id !== autoDoneOption)
                        .map(option => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {autoOn && (
                <p className="trk-muted-text">
                  {type === 'checkbox'
                    ? 'If one of the tasks is reopened, it is unticked again. '
                    : 'A reopen only changes it back while it still shows the done option, so a value someone picked by hand stays. '}
                  {column?.synced && sheetName
                    ? `This column comes from “${sheetName}”, so the change is written to the Sheet too. A cell someone changed in the Sheet since the last sync is not overwritten; the row says so instead.`
                    : sheetName
                      ? 'This column is not one the Sheet fills, so the change stays in the tracker. To send it to the Sheet, use a column connected to a Sheet column.'
                      : ''}
                </p>
              )}
              {autoOn && otherAutoDone && (
                <p className="trk-muted-text">
                  “{otherAutoDone.name}” does this now. Only one column can, so saving moves it here.
                </p>
              )}
            </fieldset>
          )}
          {contractAllowed && (
            <fieldset className="trk-options">
              <legend>Row's project</legend>
              <label className="trk-checkline">
                <input
                  type="checkbox"
                  checked={projectOn}
                  onChange={event => {
                    setProjectOn(event.target.checked)
                    if (event.target.checked) setContractOn(false)
                  }}
                />{' '}
                Show the row's project, and let it be changed here
              </label>
              {projectOn && (
                <p className="trk-muted-text">
                  Each row shows its task's project. Click it to move the task, with its subtasks, to another of this
                  tracker's projects; a row with no task picks where its task is made. Select rows and use Set project
                  to move many at once.
                  {otherProject ? ` “${otherProject.name}” does this now; saving moves it here.` : ''}
                </p>
              )}
              <label className="trk-checkline">
                <input
                  type="checkbox"
                  checked={contractOn}
                  onChange={event => {
                    setContractOn(event.target.checked)
                    if (event.target.checked) setProjectOn(false)
                  }}
                />{' '}
                Fill it with the contract number of the row's project (from Seeds)
              </label>
              {contractOn && (
                <p className="trk-muted-text">
                  Each row shows its task's project's contract number. A row with no task yet goes to the project whose
                  contract number you type here, when its task is made (one of the tracker's projects, or one of its
                  clients').
                  {otherContract ? ` “${otherContract.name}” does this now; saving moves it here.` : ''}
                </p>
              )}
            </fieldset>
          )}
          {type === 'secret' && (
            <fieldset className="trk-options" disabled={!adding && !canManageSecrets}>
              <legend>Who can reveal it</legend>
              <label className="trk-radio">
                <input
                  type="radio"
                  name="reveal"
                  checked={revealBy === 'editors'}
                  onChange={() => setRevealBy('editors')}
                />{' '}
                Anyone who can open this tracker
              </label>
              <label className="trk-radio">
                <input
                  type="radio"
                  name="reveal"
                  checked={revealBy === 'admins'}
                  onChange={() => setRevealBy('admins')}
                />{' '}
                Administrators only
              </label>
              {!adding && !canManageSecrets && (
                <p className="trk-muted-text">Only the tracker's owner or an Administrator can change this.</p>
              )}
              <p className="trk-muted-text">
                Values are encrypted before they are stored and never appear in exports, search, or filters. Each reveal
                is logged with who and when.
              </p>
            </fieldset>
          )}
          {!adding && column && canConvertType(column.type) && onConvert && (
            <label className="trk-field-block">
              Type
              <select
                value={type}
                disabled={busy}
                onChange={event => {
                  setType(event.target.value as ColumnType)
                  setReport(null)
                  setClearUnfit(false)
                  setError('')
                }}
              >
                {CONVERTIBLE_TYPES.map(item => (
                  <option key={item} value={item}>
                    {COLUMN_TYPES.find(entry => entry.type === item)?.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!adding && column && (!canConvertType(column.type) || !onConvert) && (
            <p className="trk-muted-text">
              This type of column cannot be changed after it is created. Add a new column and delete this one instead.
            </p>
          )}
          {converting && !report && (
            <p className="trk-muted-text">
              {type === 'select' ? 'The choices are made from the values already in the column. ' : ''}Next you will see
              how many values convert before anything changes.
            </p>
          )}
          {report && (
            <div className="k-notice k-notice-info" role="status">
              <div>
                <strong>
                  {report.filled - report.failed} of {report.filled} filled value{report.filled === 1 ? '' : 's'} will
                  convert to {COLUMN_TYPES.find(item => item.type === type)?.label}.
                </strong>
                {report.failed > 0 && (
                  <>
                    <p>
                      {report.failed} cannot be converted and will be cleared, for example{' '}
                      {report.samples
                        .slice(0, 4)
                        .map(sample => `row ${sample.row} “${sample.value}”`)
                        .join(', ')}
                      .
                    </p>
                    <label className="trk-checkline">
                      <input
                        type="checkbox"
                        checked={clearUnfit}
                        onChange={event => setClearUnfit(event.target.checked)}
                      />{' '}
                      Clear those {report.failed} value{report.failed === 1 ? '' : 's'}
                    </label>
                  </>
                )}
                {report.failed === 0 && (
                  <p>Nothing will be lost. Saved views that filter or sort by this column are reset.</p>
                )}
              </div>
            </div>
          )}
          {error && (
            <p className="trk-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="k-dialog-actions">
            {!adding && onDelete && (
              <button type="button" className="trk-button danger" disabled={busy} onClick={() => void remove()}>
                <Trash2 size={14} aria-hidden="true" /> Delete column
              </button>
            )}
            <span className="trk-spacer" />
            <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="trk-button primary" disabled={busy}>
              {busy
                ? 'Working…'
                : adding
                  ? 'Add column'
                  : report
                    ? 'Change type'
                    : converting
                      ? 'Check the change'
                      : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
