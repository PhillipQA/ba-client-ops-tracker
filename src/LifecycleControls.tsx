import { useState, type FormEvent } from 'react'
import { Archive, Pencil, RotateCcw, X } from 'lucide-react'
import type { Client, Project } from './types'
import { archiveBlockers, isArchived, type LifecycleStore } from './lifecycle'

type Props = { kind: 'clients' | 'projects'; record: Client | Project; store: LifecycleStore; canEdit: boolean; canRenameClient: boolean; onSave: (record: Client | Project) => Promise<void> }
export default function LifecycleControls({ kind, record, store, canEdit, canRenameClient, onSave }: Props) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const archived = isArchived(record), label = kind === 'clients' ? 'client' : 'project'
  const blockers = archived ? [] : archiveBlockers(store, kind, record.id)
  const save = async (next: Client | Project) => {
    setBusy(true); setError(''); setMessage('')
    try { await onSave(next); setEditing(false); setMessage('Changes saved.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes.') }
    finally { setBusy(false) }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const f = new FormData(event.currentTarget)
    const common = { ...record, name: kind === 'clients' && !canRenameClient ? record.name : String(f.get('name') || '').trim(), status: String(f.get('status') || record.status) }
    const next = kind === 'clients' ? { ...common, contact: String(f.get('contact') || ''), email: String(f.get('email') || ''), notes: String(f.get('notes') || ''), health: String(f.get('health') || 'Good') } : { ...common, targetDate: String(f.get('targetDate') || ''), summary: String(f.get('summary') || '') }
    void save(next as Client | Project)
  }
  return <section className="panel lifecycle-panel" aria-label={`${label} management`}>
    <div className="section-actions"><div><strong>{archived ? 'Archived · Inactive' : 'Active'}</strong><p>{archived ? `Activate this ${label} before adding or changing its work. History remains available below.` : 'Completion status and archive state are separate. Closed records can be archived when all related work is complete.'}</p></div>
      {canEdit && <div className="lifecycle-actions"><button className="secondary" disabled={busy} onClick={() => { setEditing(true); setError(''); setMessage('') }}><Pencil size={16} /> Edit {label}</button><button className="secondary" disabled={busy || (!archived && blockers.length > 0)} title={blockers.join(' ')} onClick={() => void save({ ...record, archived: !archived })}>{archived ? <RotateCcw size={16} /> : <Archive size={16} />}{archived ? 'Activate' : 'Archive / Deactivate'}</button></div>}
    </div>
    {!archived && blockers.length > 0 && <details className="lifecycle-requirements"><summary>Before this {label} can be archived</summary><ul>{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
    {error && <p className="lifecycle-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {editing && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-label={`Edit ${label}`}><div className="modal-head"><h2>Edit {label}</h2><button className="icon-button" disabled={busy} aria-label="Close editor" onClick={() => setEditing(false)}><X size={20} /></button></div>
      <form onSubmit={submit}><fieldset disabled={busy || !canEdit} className="form-grid lifecycle-fields">
        <label className="span-2">{label === 'client' ? 'Client' : 'Project'} name<input name="name" defaultValue={record.name} required maxLength={200} disabled={kind === 'clients' && !canRenameClient} />{kind === 'clients' && !canRenameClient && <small>Only an Administrator can rename this client.</small>}</label>
        <label>Completion status<select name="status" defaultValue={record.status} disabled={archived}>{(kind === 'clients' ? ['Active', 'Closing', 'Closed'] : ['Discovery', 'Active', 'UAT', 'Closing', 'Closed']).map(s => <option key={s}>{s}</option>)}</select><small>Closed means the work is done.</small></label>
        {kind === 'projects' ? <><label>Target date<input type="date" name="targetDate" defaultValue={(record as Project).targetDate} /></label><label className="span-2">Summary<textarea name="summary" rows={4} defaultValue={(record as Project).summary} /></label></> : <><label>Health<select name="health" defaultValue={(record as Client).health}><option>Good</option><option>Watch</option><option>At Risk</option></select></label><label>Primary contact<input name="contact" defaultValue={(record as Client).contact} /></label><label>Email<input type="email" name="email" defaultValue={(record as Client).email} /></label><label className="span-2">Notes<textarea name="notes" rows={4} defaultValue={(record as Client).notes} /></label></>}
        <div className="form-actions span-2"><button className="primary">{busy ? 'Saving…' : 'Save changes'}</button></div>
      </fieldset>{error && <p className="lifecycle-error" role="alert">{error}</p>}</form>
    </div></div>}
  </section>
}
