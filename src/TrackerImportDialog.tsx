import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, LockKeyhole, Upload } from 'lucide-react'
import { COLUMN_TYPES, TRACKER_LIMITS, type ColumnType, type Tracker } from './trackerModel'
import { defaultMappings, parseTable, planImport, toSource, type Mapping, type Person, type Source } from './trackerImport'
import { trackerApi, TrackerApiError } from './trackerApi'
import { Dialog, plural } from './trackerUi'
import TrackerClientPicker from './TrackerClientPicker'

type Props = {
  /** Importing into a tracker that exists, or into a new one made from the sheet. */
  tracker?: Tracker
  clients: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  people: Person[]
  today: string
  onClose: () => void
  /** Called with the tracker to open once rows have been added. */
  onDone: (trackerId: string, imported: number) => void
}

const MAX_FILE = 5 * 1024 * 1024
const IMPORT_TYPES = COLUMN_TYPES.filter(item => item.group === 'basic' || item.type === 'secret')

export default function TrackerImportDialog({ tracker, clients, projects, people, today, onClose, onDone }: Props) {
  const [step, setStep] = useState<'source' | 'map'>('source')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [header, setHeader] = useState(true)
  const [source, setSource] = useState<Source | null>(null)
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [name, setName] = useState('')
  const [clientIds, setClientIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [onlyMe, setOnlyMe] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [partial, setPartial] = useState<{ trackerId: string; imported: number } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const existing = useMemo(() => tracker?.columns || [], [tracker])
  const capacity = TRACKER_LIMITS.rows - (tracker?.rowCount || 0)

  const plan = useMemo(() => source ? planImport(source, mappings, existing, { today, people, capacity, firstRowIsHeader: header }) : null, [source, mappings, existing, today, people, capacity, header])

  const read = () => {
    setError('')
    const parsed = toSource(parseTable(text), header)
    if (!parsed.ok) return setError(parsed.error)
    setSource(parsed.source)
    setMappings(defaultMappings(parsed.source, existing, today))
    setStep('map')
  }
  const choose = async (list: FileList | null) => {
    const picked = list?.[0]
    if (!picked) return
    if (picked.size > MAX_FILE) return setError('That file is larger than 5 MB. Split it and import the parts one at a time.')
    try { setText(await picked.text()); setFileName(picked.name); setError('') } catch { setError('That file could not be read.') }
  }
  const change = (index: number, patch: Partial<Mapping>) => setMappings(list => list.map(item => item.index === index ? { ...item, ...patch } : item))

  const run = async () => {
    if (!plan || plan.fatal || busy) return
    if (!tracker && !name.trim()) return setError('Enter a name for the new tracker.')
    setBusy(true); setError(''); setPartial(null)
    let trackerId = tracker?.id || '', imported = 0
    try {
      if (tracker) {
        if (JSON.stringify(plan.columns) !== JSON.stringify(tracker.columns)) { setProgress('Adding columns…'); await trackerApi.saveColumns(tracker.id, plan.columns, tracker.revision) }
      } else {
        setProgress('Creating the tracker…')
        const created = await trackerApi.create({ name: name.trim(), columns: plan.columns, template: 'sheet', clientIds, projectId, private: onlyMe })
        trackerId = created.tracker.id
      }
      for (let at = 0; at < plan.rows.length; at += TRACKER_LIMITS.importBatch) {
        const batch = plan.rows.slice(at, at + TRACKER_LIMITS.importBatch)
        setProgress(`Importing ${Math.min(at + batch.length, plan.rows.length).toLocaleString('en')} of ${plan.rows.length.toLocaleString('en')} rows…`)
        await trackerApi.addRows(trackerId, batch.map(row => ({ cells: row.cells, secrets: row.secrets })))
        imported += batch.length
      }
      onDone(trackerId, imported)
    } catch (e) {
      const message = e instanceof TrackerApiError && e.status === 409 && e.body.tracker ? 'Someone else changed this tracker while you were importing. Close this window, review the tracker, and import again.' : e instanceof Error ? e.message : 'The import could not finish.'
      setError(imported ? `${message} ${plural(imported, 'row')} had already been added.` : message)
      if (trackerId && (imported || !tracker)) setPartial({ trackerId, imported })
      setBusy(false); setProgress('')
    }
  }

  const sample = (index: number) => (source?.rows.slice(0, 3).map(row => row[index]).filter(Boolean).join(' · ') || '').slice(0, 70)

  return <Dialog title={tracker ? `Import into “${tracker.name}”` : 'New tracker from a sheet'} eyebrow="Import" onClose={onClose} wide busy={busy}>
    {step === 'source' && <div className="trk-import">
      <p className="trk-muted-text">Copy cells from Google Sheets or Excel and paste them here, or choose a CSV file. Nothing is saved until you review the columns on the next step.</p>
      <label className="trk-field-block">Paste cells
        <textarea rows={10} value={text} spellCheck={false} placeholder={'Site\tGo-live\tStatus\nMakati branch\t11/25/2026\tNot started'} onChange={event => { setText(event.target.value); setFileName(''); setError('') }} autoFocus />
      </label>
      <div className="trk-import-row">
        <input ref={file} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden onChange={event => { void choose(event.target.files); event.target.value = '' }} />
        <button type="button" className="trk-button" onClick={() => file.current?.click()}><Upload size={14} aria-hidden="true" /> Choose a CSV file</button>
        {fileName && <span className="trk-muted-text">{fileName}</span>}
        <label className="trk-checkline"><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} /> First row has column names</label>
      </div>
      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="trk-dialog-actions"><span className="trk-spacer" /><button type="button" className="trk-button" onClick={onClose}>Cancel</button><button type="button" className="trk-button primary" disabled={!text.trim()} onClick={read}>Continue</button></div>
    </div>}

    {step === 'map' && source && plan && <div className="trk-import">
      {!tracker && <div className="trk-import-new">
        <label className="trk-field-block">Tracker name<input value={name} maxLength={TRACKER_LIMITS.nameLength} onChange={event => setName(event.target.value)} autoFocus /></label>
        <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
        <label className="trk-field-block">Project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">None</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="trk-checkline"><input type="checkbox" checked={onlyMe} onChange={event => setOnlyMe(event.target.checked)} /> Only I can see this tracker</label>
      </div>}
      <p className="trk-strip">Found <strong>{plural(source.rows.length, 'row')}</strong> and <strong>{plural(source.headers.length, 'column')}</strong>. Check what each column becomes.</p>
      <div className="trk-map-scroll">
        <table className="trk-map">
          <thead><tr><th scope="col">Use</th><th scope="col">Sheet column</th><th scope="col">Goes to</th><th scope="col">Name and type</th></tr></thead>
          <tbody>
            {mappings.map(mapping => {
              const target = existing.find(column => column.id === mapping.target)
              const looksSecret = mapping.type === 'secret'
              return <tr key={mapping.index} className={mapping.include ? '' : 'off'}>
                <td><input type="checkbox" checked={mapping.include} aria-label={`Import ${source.headers[mapping.index]}`} onChange={event => change(mapping.index, { include: event.target.checked })} /></td>
                <td><strong>{source.headers[mapping.index]}</strong><small>{sample(mapping.index)}</small></td>
                <td><select aria-label={`Where ${source.headers[mapping.index]} goes`} value={mapping.target} disabled={!mapping.include}
                  onChange={event => { const column = existing.find(item => item.id === event.target.value); change(mapping.index, column ? { target: column.id, name: column.name, type: column.type } : { target: 'new' }) }}>
                  <option value="new">A new column</option>
                  {existing.filter(column => ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'multiselect', 'person', 'link', 'secret'].includes(column.type)).map(column => <option key={column.id} value={column.id}>{column.name}</option>)}
                </select></td>
                <td>{target
                  ? <span className="trk-muted-text">{COLUMN_TYPES.find(item => item.type === target.type)?.label}</span>
                  : <div className="trk-map-new">
                    <input aria-label={`Name for ${source.headers[mapping.index]}`} value={mapping.name} maxLength={TRACKER_LIMITS.columnName} disabled={!mapping.include} onChange={event => change(mapping.index, { name: event.target.value })} />
                    <select aria-label={`Type for ${source.headers[mapping.index]}`} value={mapping.type} disabled={!mapping.include} onChange={event => change(mapping.index, { type: event.target.value as ColumnType })}>
                      {IMPORT_TYPES.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
                    </select>
                  </div>}
                  {mapping.include && looksSecret && <small className="trk-secret-note"><LockKeyhole size={12} aria-hidden="true" /> Stored encrypted, hidden in the grid, left out of exports.</small>}
                </td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      {plan.fatal && <p className="trk-field-error" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {plan.fatal}</p>}
      {!plan.fatal && <p className="trk-muted-text">{plural(plan.rows.length, 'row')} will be added{plan.added.length ? ` with ${plural(plan.added.length, 'new column')}` : ''}.</p>}
      {plan.warnings.length > 0 && <ul className="trk-issues">{plan.warnings.slice(0, 6).map(warning => <li key={warning}>{warning}</li>)}</ul>}
      {plan.problems.length > 0 && <details className="trk-issues"><summary>{plural(plan.problems.length, 'cell')} could not be read and will be left empty</summary>
        <ul>{plan.problems.slice(0, 20).map((problem, at) => <li key={at}>Row {problem.row}, {problem.column}: “{problem.value}” — {problem.message}</li>)}{plan.problems.length > 20 && <li>…and {plan.problems.length - 20} more.</li>}</ul></details>}
      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="trk-dialog-actions">
        <button type="button" className="trk-button" disabled={busy} onClick={() => { setStep('source'); setError('') }}>Back</button>
        <span className="trk-spacer" />
        {progress && <span className="trk-muted-text" role="status">{progress}</span>}
        {partial && <button type="button" className="trk-button" onClick={() => onDone(partial.trackerId, partial.imported)}>Open what was imported</button>}
        <button type="button" className="trk-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="trk-button primary" disabled={busy || Boolean(plan.fatal)} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${plural(plan.rows.length, 'row')}`}</button>
      </div>
    </div>}
  </Dialog>
}
