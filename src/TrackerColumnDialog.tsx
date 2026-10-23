import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import type { ConvertReport } from './trackerApi'
import {
  CONVERTIBLE_TYPES, canConvertType, COLUMN_TYPES, OPTION_COLORS, TRACKER_LIMITS, randomId, type ColumnGroup, type ColumnType, type OptionColor, type RevealBy, type SelectOption, type TrackerColumn,
} from './trackerModel'
import { ColumnIcon, Dialog, Pill } from './trackerUi'

export type ColumnDraft = { name: string; type: ColumnType; options?: SelectOption[]; revealBy?: RevealBy }

type Props = {
  mode: 'add' | 'edit'
  columns: TrackerColumn[]
  column?: TrackerColumn
  onClose: () => void
  onSave: (draft: ColumnDraft) => Promise<void>
  onDelete?: () => Promise<void>
  /** Checks (confirm false) or applies (confirm true) a change of the column's type. */
  onConvert?: (type: ColumnType, confirm: boolean, clearUnfit: boolean) => Promise<ConvertReport>
}

const GROUPS: { id: ColumnGroup; label: string; about: string }[] = [
  { id: 'basic', label: 'Basic', about: 'You type or pick the value.' },
  { id: 'connected', label: 'Fills itself', about: 'Read from the task a row is linked to. Nothing is typed in.' },
  { id: 'protected', label: 'Protected', about: 'Encrypted, hidden, and logged whenever it is revealed.' },
]

const nextColor = (count: number): OptionColor => OPTION_COLORS[(count % (OPTION_COLORS.length - 1)) + 1]

export default function TrackerColumnDialog({ mode, columns, column, onClose, onSave, onDelete, onConvert }: Props) {
  const adding = mode === 'add'
  const [type, setType] = useState<ColumnType>(column?.type || 'text')
  const [name, setName] = useState(column?.name || '')
  const [options, setOptions] = useState<SelectOption[]>(() => (column?.options || []).map(option => ({ ...option })))
  const [revealBy, setRevealBy] = useState<RevealBy>(column?.revealBy || 'editors')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lastOption = useRef<HTMLInputElement>(null)
  const info = COLUMN_TYPES.find(item => item.type === type)!
  const converting = !adding && Boolean(column) && type !== column!.type
  const hasOptions = (type === 'select' || type === 'multiselect') && !converting
  const [report, setReport] = useState<Extract<ConvertReport, { applied: false }> | null>(null)
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
  const setOption = (id: string, patch: Partial<SelectOption>) => setOptions(list => list.map(option => option.id === id ? { ...option, ...patch } : option))
  const addOption = (label = '') => {
    setOptions(list => list.length >= TRACKER_LIMITS.optionsPerColumn ? list : [...list, { id: randomId('o_'), label, color: nextColor(list.length) }])
    window.setTimeout(() => lastOption.current?.focus(), 0)
  }
  const paste = (id: string, text: string) => {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length < 2) return false
    setOptions(list => {
      const at = list.findIndex(option => option.id === id)
      const added = lines.slice(1).map((label, i) => ({ id: randomId('o_'), label, color: nextColor(list.length + i) }))
      const next = list.map(option => option.id === id ? { ...option, label: lines[0] } : option)
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
    if (trimmed.length > TRACKER_LIMITS.columnName) return setError(`The name can be at most ${TRACKER_LIMITS.columnName} characters.`)
    if (columns.some(other => other.id !== column?.id && other.name.toLowerCase() === trimmed.toLowerCase())) return setError(`There is already a column named “${trimmed}”.`)
    if (adding && columns.length >= TRACKER_LIMITS.columns) return setError(`A tracker can have at most ${TRACKER_LIMITS.columns} columns.`)
    const cleaned = options.map(option => ({ ...option, label: option.label.trim() })).filter(option => option.label)
    if (new Set(cleaned.map(option => option.label.toLowerCase())).size !== cleaned.length) return setError('Two options have the same name.')
    if (converting && onConvert && !report) {
      // First ask what the change would do, and show it before anything is touched.
      setBusy(true); setError('')
      try {
        const result = await onConvert(type, false, false)
        if (!result.applied) setReport(result)
      } catch (e) { setError(e instanceof Error ? e.message : 'The type could not be checked.') }
      setBusy(false); return
    }
    if (converting && report && report.failed > 0 && !clearUnfit) return setError('Tick the box to confirm those values will be cleared, or cancel and fix them first.')
    setBusy(true); setError('')
    try {
      const sameType = { name: trimmed, type: column?.type || type, ...((column?.type === 'select' || column?.type === 'multiselect') ? { options: cleaned } : {}), ...(column?.type === 'secret' ? { revealBy } : {}) }
      const renamed = column && (trimmed !== column.name || (sameType.options && JSON.stringify(sameType.options) !== JSON.stringify(column.options || [])) || (column.type === 'secret' && revealBy !== (column.revealBy || 'editors')))
      if (converting && onConvert) {
        if (renamed) await onSave(sameType as ColumnDraft)
        await onConvert(type, true, clearUnfit)
      } else await onSave({ name: trimmed, type, ...(hasOptions ? { options: cleaned } : {}), ...(type === 'secret' ? { revealBy } : {}) })
      onClose()
    }
    catch (e) { setError(e instanceof Error ? e.message : 'The column could not be saved.'); setBusy(false) }
  }
  const remove = async () => {
    if (!onDelete || busy) return
    const secret = column?.type === 'secret'
    if (!window.confirm(`Delete the column “${column?.name}”? ${secret ? 'Every value stored in it is permanently erased. ' : 'The values in it are removed from every row. '}This cannot be undone.`)) return
    setBusy(true); setError('')
    try { await onDelete(); onClose() } catch (e) { setError(e instanceof Error ? e.message : 'The column could not be deleted.'); setBusy(false) }
  }

  return <Dialog title={adding ? 'Add a column' : `Edit “${column?.name}”`} eyebrow={adding ? 'New column' : 'Column'} onClose={onClose} wide={adding} busy={busy}>
    <form className={adding ? 'trk-columns-form' : 'trk-columns-form single'} onSubmit={event => void submit(event)}>
      {adding && <div className="trk-type-list">
        <label className="trk-search"><Search size={14} aria-hidden="true" /><input autoFocus placeholder="Search column types" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search column types" /></label>
        <div className="trk-type-scroll">
          {GROUPS.map(group => {
            const list = shown.filter(item => item.group === group.id)
            if (!list.length) return null
            return <section key={group.id} aria-label={group.label}>
              <h3>{group.label}<small>{group.about}</small></h3>
              {list.map(item => <button type="button" key={item.type} className={item.type === type ? 'selected' : ''} aria-pressed={item.type === type} onClick={() => choose(item.type)}>
                <ColumnIcon type={item.type} size={16} /><span>{item.label}</span></button>)}
            </section>
          })}
          {!shown.length && <p className="trk-muted-text">No column type matches “{query}”.</p>}
        </div>
      </div>}
      <div className="trk-config">
        <div className="trk-config-head"><ColumnIcon type={type} size={18} /><div><strong>{info.label}</strong><p>{info.about}</p></div></div>
        <label className="trk-field-block">Column name
          <input value={name} onChange={event => { setName(event.target.value); setError('') }} maxLength={TRACKER_LIMITS.columnName} autoFocus={!adding} required />
        </label>
        {hasOptions && <fieldset className="trk-options"><legend>Options</legend>
          {options.map((option, at) => <div key={option.id} className="trk-option-row">
            <div className="trk-swatches" role="radiogroup" aria-label={`Colour for ${option.label || 'option'}`}>
              {OPTION_COLORS.map(color => <button type="button" key={color} role="radio" aria-checked={option.color === color} aria-label={color} className={`trk-swatch trk-tone-${color}${option.color === color ? ' on' : ''}`} onClick={() => setOption(option.id, { color })} />)}
            </div>
            <input ref={at === options.length - 1 ? lastOption : undefined} value={option.label} aria-label={`Option ${at + 1}`} maxLength={TRACKER_LIMITS.optionLabel} placeholder="Option name"
              onChange={event => setOption(option.id, { label: event.target.value })}
              onPaste={event => { if (paste(option.id, event.clipboardData.getData('text'))) event.preventDefault() }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addOption() } }} />
            <button type="button" className="trk-icon-button small" aria-label={`Remove ${option.label || 'option'}`} onClick={() => setOptions(list => list.filter(item => item.id !== option.id))}><Trash2 size={14} /></button>
          </div>)}
          <div className="trk-option-actions">
            <button type="button" className="trk-text-button strong" onClick={() => addOption()} disabled={options.length >= TRACKER_LIMITS.optionsPerColumn}><Plus size={13} aria-hidden="true" /> Add option</button>
            {options.length > 0 && <span className="trk-preview" aria-hidden="true">{options.filter(option => option.label.trim()).slice(0, 4).map(option => <Pill key={option.id} tone={option.color}>{option.label}</Pill>)}</span>}
          </div>
          {!adding && <p className="trk-muted-text">Removing an option empties that value wherever it is used.</p>}
        </fieldset>}
        {type === 'secret' && <fieldset className="trk-options"><legend>Who can reveal it</legend>
          <label className="trk-radio"><input type="radio" name="reveal" checked={revealBy === 'editors'} onChange={() => setRevealBy('editors')} /> Anyone who can open this tracker</label>
          <label className="trk-radio"><input type="radio" name="reveal" checked={revealBy === 'admins'} onChange={() => setRevealBy('admins')} /> Administrators only</label>
          <p className="trk-muted-text">Values are encrypted before they are stored and never appear in exports, search, or filters. Each reveal is logged with who and when.</p>
        </fieldset>}
        {!adding && column && canConvertType(column.type) && onConvert && <label className="trk-field-block">Type
          <select value={type} disabled={busy} onChange={event => { setType(event.target.value as ColumnType); setReport(null); setClearUnfit(false); setError('') }}>
            {CONVERTIBLE_TYPES.map(item => <option key={item} value={item}>{COLUMN_TYPES.find(entry => entry.type === item)?.label}</option>)}
          </select>
        </label>}
        {!adding && column && (!canConvertType(column.type) || !onConvert) && <p className="trk-muted-text">This type of column cannot be changed after it is created. Add a new column and delete this one instead.</p>}
        {converting && !report && <p className="trk-muted-text">{type === 'select' ? 'The choices are made from the values already in the column. ' : ''}Next you will see how many values convert before anything changes.</p>}
        {report && <div className="trk-notice trk-notice-info" role="status"><div>
          <strong>{report.filled - report.failed} of {report.filled} filled value{report.filled === 1 ? '' : 's'} will convert to {COLUMN_TYPES.find(item => item.type === type)?.label}.</strong>
          {report.failed > 0 && <>
            <p>{report.failed} cannot be converted and will be cleared, for example {report.samples.slice(0, 4).map(sample => `row ${sample.row} “${sample.value}”`).join(', ')}.</p>
            <label className="trk-checkline"><input type="checkbox" checked={clearUnfit} onChange={event => setClearUnfit(event.target.checked)} /> Clear those {report.failed} value{report.failed === 1 ? '' : 's'}</label>
          </>}
          {report.failed === 0 && <p>Nothing will be lost. Saved views that filter or sort by this column are reset.</p>}
        </div></div>}
        {error && <p className="trk-field-error" role="alert">{error}</p>}
        <div className="trk-dialog-actions">
          {!adding && onDelete && <button type="button" className="trk-button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Delete column</button>}
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="trk-button primary" disabled={busy}>{busy ? 'Working…' : adding ? 'Add column' : report ? 'Change type' : converting ? 'Check the change' : 'Save'}</button>
        </div>
      </div>
    </form>
  </Dialog>
}
