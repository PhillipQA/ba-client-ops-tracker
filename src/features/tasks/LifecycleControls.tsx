import { useState } from 'react'
import { Archive, RotateCcw } from 'lucide-react'
import type { Client, Project } from '../../shared/types'
import { archiveBlockers, isArchived, type LifecycleStore } from './lifecycle'

type Props = { kind: 'clients' | 'projects'; record: Client | Project; store: LifecycleStore; canEdit: boolean; onSave: (record: Client | Project) => Promise<void> }
export default function LifecycleControls({ kind, record, store, canEdit, onSave }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const archived = isArchived(record), label = kind === 'clients' ? 'client' : 'project'
  const blockers = archived ? [] : archiveBlockers(store, kind, record.id)
  const toggle = async () => {
    setBusy(true); setError(''); setMessage('')
    try { await onSave({ ...record, archived: !archived }); setMessage(archived ? 'Activated.' : 'Archived.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save changes.') }
    finally { setBusy(false) }
  }
  return <section className="lifecycle-toolbar" aria-label={`${label} availability`}>
    <div className="lifecycle-toolbar-row"><div className="lifecycle-availability"><span className={`availability-dot${archived ? ' is-archived' : ''}`} /><strong>{archived ? 'Archived · Inactive' : 'Active'}</strong>{archived && <span>Activate to resume work</span>}</div>
      {canEdit && <button className="secondary compact" disabled={busy || (!archived && blockers.length > 0)} title={blockers.join(' ')} onClick={() => void toggle()}>{archived ? <RotateCcw size={15} /> : <Archive size={15} />}{archived ? 'Activate' : 'Archive / Deactivate'}</button>}
    </div>
    {!archived && blockers.length > 0 && <details className="lifecycle-requirements"><summary>Archive requirements</summary><ul>{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></details>}
    {error && <p className="lifecycle-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>
}
