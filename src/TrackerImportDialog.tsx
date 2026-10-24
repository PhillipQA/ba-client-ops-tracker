import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, LockKeyhole, Search, Upload } from 'lucide-react'
import { COLUMN_TYPES, TRACKER_LIMITS, type ColumnType, type Tracker } from './trackerModel'
import { defaultMappings, parseTable, planImport, toSource, type Mapping, type Person, type Source } from './trackerImport'
import { trackerApi, TrackerApiError, type SheetFile } from './trackerApi'
import { sheetIdFrom } from './trackerSync'
import { rememberReview } from './trackerNav'
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
  /** Called with the tracker to open once rows have been added, and the new rows (for the Create tasks review). */
  onDone: (trackerId: string, imported: number, rowIds?: string[]) => void
  /** Make a new tracker that follows a Google Sheet, instead of importing a copy. */
  fromSheet?: boolean
}

const MAX_FILE = 5 * 1024 * 1024
const IMPORT_TYPES = COLUMN_TYPES.filter(item => item.group === 'basic' || item.type === 'secret')

export default function TrackerImportDialog({ tracker, clients, projects, people, today, onClose, onDone, fromSheet = false }: Props) {
  const [step, setStep] = useState<'source' | 'sheet' | 'map'>(fromSheet ? 'sheet' : 'source')
  // Google Sheet source: who is signed in, the Sheets they can open, the chosen Sheet and tab, and the key column.
  const [google, setGoogle] = useState<{ available: boolean; connected: boolean; email: string } | null>(null)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<SheetFile[] | null>(null)
  const [sheet, setSheet] = useState<{ id: string; name: string; tabs: { title: string; rows: number }[] } | null>(null)
  const [tab, setTab] = useState('')
  const [keyHeader, setKeyHeader] = useState('')
  const [looking, setLooking] = useState(false)
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
  const [partial, setPartial] = useState<{ trackerId: string; imported: number; ids: string[] } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const existing = useMemo(() => tracker?.columns || [], [tracker])
  const capacity = TRACKER_LIMITS.rows - (tracker?.rowCount || 0)

  useEffect(() => {
    if (!fromSheet) return
    trackerApi.sheetsStatus().then(setGoogle).catch(() => setGoogle({ available: false, connected: false, email: '' }))
  }, [fromSheet])
  useEffect(() => {
    if (!fromSheet || !google?.connected) return
    const timer = window.setTimeout(() => { trackerApi.sheetFiles(query).then(result => setFiles(result.files)).catch(e => setError(e instanceof Error ? e.message : 'Your Sheets could not be listed.')) }, query ? 300 : 0)
    return () => window.clearTimeout(timer)
  }, [fromSheet, google?.connected, query])
  const allowSheets = async () => {
    try {
      const response = await fetch('/api/communications/gmail/connect?sheets=1', { credentials: 'same-origin' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
      window.location.assign(result.url)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start the Google permission step.') }
  }
  const openSheet = async (idOrLink: string) => {
    const id = sheetIdFrom(idOrLink)
    if (!id) return setError('That is not a Google Sheets link. Copy the address of the Sheet from your browser.')
    setLooking(true); setError('')
    try { const result = await trackerApi.sheetTabs(id); setSheet({ id: result.id, name: result.name, tabs: result.tabs }); setTab(result.tabs[0]?.title || ''); if (!name.trim()) setName(result.name.slice(0, TRACKER_LIMITS.nameLength)) }
    catch (e) { setError(e instanceof Error ? e.message : 'That Sheet could not be opened.') }
    finally { setLooking(false) }
  }
  const readSheet = async () => {
    if (!sheet || !tab) return
    setLooking(true); setError('')
    try {
      const result = await trackerApi.sheetValues(sheet.id, tab)
      const parsed = toSource(result.grid, true)
      if (!parsed.ok) throw new Error(parsed.error)
      setSource(parsed.source); setHeader(true)
      setMappings(defaultMappings(parsed.source, existing, today).map(mapping => mapping.type === 'secret' ? { ...mapping, type: 'text' } : mapping))
      setKeyHeader(parsed.source.headers[0] || '')
      setStep('map')
    } catch (e) { setError(e instanceof Error ? e.message : 'The Sheet could not be read.') }
    finally { setLooking(false) }
  }

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
    if (fromSheet && sheet) return void connect()
    setBusy(true); setError(''); setPartial(null)
    let trackerId = tracker?.id || '', imported = 0
    const ids: string[] = []
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
        const added = await trackerApi.addRows(trackerId, batch.map(row => ({ cells: row.cells, secrets: row.secrets })))
        ids.push(...added.rows.map(row => row.id))
        imported += batch.length
      }
      // A new tracker opens with the review of its rows; an existing one opens it from onDone.
      if (!tracker && ids.length) rememberReview(trackerId, ids)
      onDone(trackerId, imported, ids)
    } catch (e) {
      const message = e instanceof TrackerApiError && e.status === 409 && e.body.tracker ? 'Someone else changed this tracker while you were importing. Close this window, review the tracker, and import again.' : e instanceof Error ? e.message : 'The import could not finish.'
      setError(imported ? `${message} ${plural(imported, 'row')} had already been added.` : message)
      if (trackerId && (imported || !tracker)) setPartial({ trackerId, imported, ids })
      setBusy(false); setProgress('')
    }
  }

  /** A new tracker that follows the Sheet: columns from the mapping, then the connection, then the first sync. */
  const connect = async () => {
    if (!plan || !sheet || busy) return
    if (!name.trim()) return setError('Enter a name for the new tracker.')
    const chosen = mappings.filter(mapping => mapping.include)
    if (!chosen.length) return setError('Choose at least one column to follow.')
    if (!keyHeader || !chosen.some(mapping => source?.headers[mapping.index] === keyHeader)) return setError('Choose the key column, and keep it ticked: it is how each row is recognised on every sync.')
    setBusy(true); setError('')
    try {
      setProgress('Creating the tracker…')
      const created = await trackerApi.create({ name: name.trim(), columns: plan.columns, template: 'sheet', clientIds, projectId, private: onlyMe })
      // Each chosen Sheet column goes to the tracker column made for it (new columns are made in the same order).
      const headerMap: Record<string, string> = {}
      let added = 0
      for (const mapping of chosen) {
        const column = mapping.target === 'new' ? plan.added[added++] : plan.columns.find(item => item.id === mapping.target)
        const saved = created.tracker.columns.find(item => item.id === column?.id) || created.tracker.columns.find(item => item.name === column?.name)
        if (saved && source) headerMap[source.headers[mapping.index]] = saved.id
      }
      setProgress('Reading the Sheet…')
      const result = await trackerApi.connectSource(created.tracker.id, { spreadsheetId: sheet.id, spreadsheetName: sheet.name, tab, keyHeader, headerMap })
      rememberReview(created.tracker.id, 'flagged')
      onDone(created.tracker.id, result.report?.added || 0)
    } catch (e) {
      setError(e instanceof TrackerApiError && e.body.needsGoogle ? 'Allow Google Sheets first (button above), then try again.' : e instanceof Error ? e.message : 'The Sheet could not be connected.')
      setBusy(false); setProgress('')
    }
  }

  const sample = (index: number) => (source?.rows.slice(0, 3).map(row => row[index]).filter(Boolean).join(' · ') || '').slice(0, 70)

  return <Dialog title={fromSheet ? 'New tracker from a Google Sheet' : tracker ? `Import into “${tracker.name}”` : 'New tracker from a sheet'} eyebrow={fromSheet ? 'Connect' : 'Import'} onClose={onClose} wide busy={busy}>
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

    {step === 'sheet' && <div className="trk-import trk-sheet-pick">
      <p className="trk-muted-text">The tracker follows one tab of the Sheet: new and changed rows come in on every sync (Sheet → tracker). The Sheet itself is never changed.</p>
      {google === null && <p role="status" className="trk-muted-text">Checking your Google account…</p>}
      {google && !google.available && <p className="trk-field-error">Google is not set up for this account yet. An Administrator connects it in Settings → Integrations (the same setup as Gmail in Work Hub).</p>}
      {google?.available && !google.connected && <div className="trk-notice trk-notice-info"><div>
        <strong>Allow the tracker to read your Google Sheets</strong>
        <p>Google asks you once. The tracker can then list the Sheets you can open, including ones shared with you and shared drives, and read the one you choose. It cannot change them.</p>
        <button type="button" className="trk-button primary" onClick={() => void allowSheets()}>Allow Google Sheets</button>
      </div></div>}
      {google?.connected && <>
        <p className="trk-muted-text">Signed in to Google as <strong>{google.email}</strong>.</p>
        <label className="trk-picker-find"><Search size={14} aria-hidden="true" /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your Sheets, or paste a Sheet link" aria-label="Search your Sheets or paste a link"
          onKeyDown={event => { if (event.key === 'Enter' && sheetIdFrom(query)) { event.preventDefault(); void openSheet(query) } }} /></label>
        {sheetIdFrom(query) && <button type="button" className="trk-button" disabled={looking} onClick={() => void openSheet(query)}>Open this link</button>}
        {!sheetIdFrom(query) && <div className="trk-sheet-list" role="list" aria-label="Your Sheets">
          {files === null && <p className="trk-muted-text">Loading your Sheets…</p>}
          {files?.map(file => <button type="button" role="listitem" key={file.id} className={sheet?.id === file.id ? 'selected' : ''} disabled={looking} onClick={() => void openSheet(file.id)}>
            <strong>{file.name}</strong><small>{[file.sharedDrive ? 'Shared drive' : file.shared ? 'Shared' : 'My Drive', file.owner, file.modifiedTime ? `changed ${new Date(file.modifiedTime).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''].filter(Boolean).join(' · ')}</small>
          </button>)}
          {files && !files.length && <p className="trk-muted-text">{query ? 'No Sheet matches. Paste the Sheet link instead.' : 'No Sheets found for this Google account.'}</p>}
        </div>}
        {sheet && <div className="trk-sheet-chosen">
          <span><strong>{sheet.name}</strong> <a href={`https://docs.google.com/spreadsheets/d/${sheet.id}/edit`} target="_blank" rel="noopener noreferrer" aria-label="Open the Sheet"><ExternalLink size={12} /></a></span>
          <label className="trk-field-block">Tab<select value={tab} onChange={event => setTab(event.target.value)}>{sheet.tabs.map(item => <option key={item.title} value={item.title}>{item.title}</option>)}</select></label>
        </div>}
      </>}
      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="trk-dialog-actions"><span className="trk-spacer" />{looking && <span className="trk-muted-text" role="status">Opening…</span>}<button type="button" className="trk-button" onClick={onClose}>Cancel</button><button type="button" className="trk-button primary" disabled={!sheet || !tab || looking} onClick={() => void readSheet()}>Continue</button></div>
    </div>}

    {step === 'map' && source && plan && <div className="trk-import">
      {!tracker && <div className="trk-import-new">
        <label className="trk-field-block">Tracker name<input value={name} maxLength={TRACKER_LIMITS.nameLength} onChange={event => setName(event.target.value)} autoFocus /></label>
        <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
        <label className="trk-field-block">Project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">None</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="trk-checkline"><input type="checkbox" checked={onlyMe} onChange={event => setOnlyMe(event.target.checked)} /> Only I can see this tracker</label>
      </div>}
      <p className="trk-strip">Found <strong>{plural(source.rows.length, 'row')}</strong> and <strong>{plural(source.headers.length, 'column')}</strong>. Check what each column becomes.</p>
      {fromSheet && <label className="trk-field-block trk-key-column">Key column: what names each row, such as a branch number. Rows are matched by it on every sync, so it should be unique and not change.
        <select value={keyHeader} onChange={event => setKeyHeader(event.target.value)}>{source.headers.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
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
                      {IMPORT_TYPES.filter(item => !fromSheet || item.type !== 'secret').map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
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
        <button type="button" className="trk-button" disabled={busy} onClick={() => { setStep(fromSheet ? 'sheet' : 'source'); setError('') }}>Back</button>
        <span className="trk-spacer" />
        {progress && <span className="trk-muted-text" role="status">{progress}</span>}
        {partial && <button type="button" className="trk-button" onClick={() => onDone(partial.trackerId, partial.imported, partial.ids)}>Open what was imported</button>}
        <button type="button" className="trk-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="trk-button primary" disabled={busy || Boolean(plan.fatal)} onClick={() => void run()}>{busy ? (fromSheet ? 'Connecting…' : 'Importing…') : fromSheet ? `Connect and bring in ${plural(plan.rows.length, 'row')}` : `Import ${plural(plan.rows.length, 'row')}`}</button>
      </div>
    </div>}
  </Dialog>
}
