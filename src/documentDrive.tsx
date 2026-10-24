import { useEffect, useMemo, useState } from 'react'
import { CloudUpload, FolderOpen, X } from 'lucide-react'
import type { TaskDriveFile, WorkItem } from './types'
import type { GeneratedDocument } from './dochub'
import { driveFileGroups, fileSize, placeOf, taskChoices, type DriveScope } from './documentDriveTargets'
import './documentDrive.css'
import { useIsClosed } from './openWork'
import ClientSelect from './ClientSelect'
import { SearchSelect } from './ClientSelect'

/** Google Drive in Document Creation: pick a saved COR for a DRF, and file generated documents under a task. */

async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok && data.code !== 'ALREADY_SAVED') throw new Error(data.error || 'Google Drive request failed.')
  return { ...data, ok: response.ok } as any
}

/** Whether Google Drive is connected for this account. Quietly false when it is not or the request fails. */
export function useDocumentDrive(active = true) {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void fetch('/api/documents/drive', { credentials: 'same-origin', signal: controller.signal })
      .then(response => response.ok ? response.json() : { available: false })
      .then(data => setAvailable(Boolean(data.available)))
      .catch(() => { if (!controller.signal.aborted) setAvailable(false) })
    return () => controller.abort()
  }, [active])
  return available
}

const GENERATED = 'document-generated'
/** Each generator announces the file it just produced so the Save to Drive bar can offer it. */
export function announceGeneratedDocument(flow: string, file: GeneratedDocument) {
  window.dispatchEvent(new CustomEvent(GENERATED, { detail: { flow, file } }))
}

/** "Choose from Google Drive": lists the files the tracker saved to task folders, grouped by task or subtask. */
export function DriveFilePicker({ items, clients, projects, accept, maxBytes, disabled, onPick, onError }: DriveScope & { accept: string; maxBytes: number; disabled?: boolean; onPick: (file: File) => void; onError?: (message: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [clientId, setClientId] = useState(''), [loading, setLoading] = useState(''), [error, setError] = useState('')
  const allowed = useMemo(() => new Set(accept.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)), [accept])
  const scope = { items, clients, projects }
  const groups = useMemo(() => driveFileGroups(scope, { allowed, clientId, query }), [items, clients, projects, query, clientId, allowed])
  const use = async (item: WorkItem, file: TaskDriveFile) => {
    setLoading(file.id); setError('')
    try {
      const response = await fetch(`/api/documents/drive/file?taskId=${encodeURIComponent(item.id)}&fileId=${encodeURIComponent(file.id)}&maxBytes=${maxBytes}`, { credentials: 'same-origin' })
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Could not get this file from Google Drive.') }
      const blob = await response.blob()
      onPick(new File([blob], file.name, { type: file.mimeType || blob.type }))
      setOpen(false)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not get this file from Google Drive.'
      setError(message); onError?.(message)
    } finally { setLoading('') }
  }
  return <div className="document-drive-picker">
    <button type="button" className="secondary document-wide-button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}><FolderOpen size={16} /> Choose from Google Drive</button>
    {open && <div className="document-drive-panel" role="region" aria-label="Files saved in Google Drive">
      <div className="document-drive-head"><div><strong>Files saved in Google Drive</strong><small>Files saved from Work Hub attachments and signed documents, grouped by task or subtask. The chosen file passes through the tracker to your browser and is not stored.</small></div>
        <button type="button" className="icon-button" aria-label="Close Google Drive files" onClick={() => setOpen(false)}><X size={16} /></button></div>
      <div className="document-drive-filters">
        <label>Client<ClientSelect clients={clients.filter(c => !c.archived)} value={clientId} onChange={(value) => setClientId(value)} extra={[{ value: '', label: 'All clients' }]} /></label>
        <label>Search<input value={query} onChange={e => setQuery(e.target.value)} placeholder="File or task name" /></label>
      </div>
      {error && <p role="alert" className="document-drive-error">{error}</p>}
      {!groups.length
        ? <p className="document-drive-empty">No matching files yet. In Work Hub, use Save to Drive on an email attachment (for example the COR), then it appears here under its task or subtask.</p>
        : <ul className="document-drive-groups">{groups.map(({ item, files }) => <li key={item.id}>
          <strong>{item.parentTaskId ? '↳ ' : ''}{item.title}</strong><small>{placeOf(scope, item)}</small>
          <ul>{files.map(file => <li key={file.id}>
            <span className="document-drive-file">{file.name}<small>{fileSize(file.size)} · {new Date(file.savedAt).toLocaleDateString()}{file.savedByName ? ` · ${file.savedByName}` : ''}</small></span>
            <button type="button" className="secondary compact" disabled={Boolean(loading) || file.size > maxBytes} title={file.size > maxBytes ? `Larger than the ${fileSize(maxBytes)} limit` : undefined} onClick={() => void use(item, file)}>{loading === file.id ? 'Loading…' : file.size > maxBytes ? 'Too large' : 'Use this file'}</button>
          </li>)}</ul></li>)}</ul>}
    </div>}
  </div>
}

/** After a document is generated, file it under a task or subtask in the shared Google Drive. */
export function SaveToDriveBar({ flow, label, items, clients, projects }: DriveScope & { flow: string; label: string }) {
  const available = useDocumentDrive(true)
  const [file, setFile] = useState<GeneratedDocument | null>(null), [clientId, setClientId] = useState(''), [taskId, setTaskId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<{ url: string; where: string; note?: string } | null>(null)
  useEffect(() => {
    const listen = (event: Event) => {
      const detail = (event as CustomEvent<{ flow: string; file: GeneratedDocument }>).detail
      if (detail?.flow !== flow) return
      setFile(detail.file); setSaved(null); setError('')
    }
    window.addEventListener(GENERATED, listen)
    return () => window.removeEventListener(GENERATED, listen)
  }, [flow])
  const isClosed = useIsClosed()
  const options = useMemo(() => [{ value: '', label: 'Choose a task or subtask' }, ...taskChoices({ items, clients, projects }, clientId, isClosed)], [items, clients, projects, clientId, isClosed])
  if (!available || !file) return null
  const save = async () => {
    if (!taskId || busy) return
    setBusy(true); setError('')
    try {
      const result = await request('/api/documents/drive/save', 'POST', { taskId, fileName: file.fileName, mimeType: file.mimeType, fileData: file.fileData })
      setSaved({ url: result.file?.url || '', where: (result.path || []).join(' / '), note: result.ok ? undefined : result.error })
      window.dispatchEvent(new Event('dochub-updated'))
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save to Google Drive.') }
    finally { setBusy(false) }
  }
  return <section className="document-drive-save" aria-label={`Save ${label} to Google Drive`}>
    <h3><CloudUpload size={18} /> Save {label} to Google Drive</h3>
    <p>Files “{file.fileName}” in the team Drive under Client / Project / Task / Subtask. The app keeps no copy.</p>
    <div className="document-drive-filters">
      <label>Client<ClientSelect clients={clients.filter(c => !c.archived)} value={clientId} onChange={(value) => { setClientId(value); setTaskId('') }} extra={[{ value: '', label: 'All clients' }]} disabled={busy} /></label>
      <label className="document-field-wide">Task or subtask<SearchSelect choices={options} value={taskId} disabled={busy} onChange={setTaskId} placeholder="Type a task or subtask" empty="No open task or subtask matches" /></label>
    </div>
    <div className="document-drive-actions"><button type="button" className="primary" disabled={!taskId || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save to Google Drive'}</button></div>
    {error && <p role="alert" className="document-drive-error">{error}</p>}
    {saved && <p role="status" className="document-drive-saved">{saved.note || 'Saved'}{saved.where ? ` · ${saved.where}` : ''} {saved.url && <a href={saved.url} target="_blank" rel="noopener noreferrer">Open in Drive</a>}</p>}
  </section>
}
