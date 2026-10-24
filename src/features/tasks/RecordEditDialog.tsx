import { useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import type { Client, Project } from '../../shared/types'
import { isArchived } from './lifecycle'
import { useModalDialog } from '../../shared/ui/useModalDialog'

type Props = {
  kind: 'clients' | 'projects'
  record: Client | Project
  canRenameClient: boolean
  onClose: () => void
  onSave: (record: Client | Project) => Promise<void>
}
export default function RecordEditDialog({ kind, record, canRenameClient, onClose, onSave }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const client = kind === 'clients',
    archived = isArchived(record)
  useModalDialog(dialog, element => {
    const firstInput = element.querySelector<HTMLInputElement>(
      client && !canRenameClient ? '[name=contact]' : '[name=name]',
    )
    firstInput?.focus()
    firstInput?.select()
  })
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const common = {
      ...record,
      name: client && !canRenameClient ? record.name : String(form.get('name') || '').trim(),
      status: String(form.get('status') || record.status),
    }
    const next = client
      ? {
          ...common,
          contact: String(form.get('contact') || ''),
          email: String(form.get('email') || ''),
          health: String(form.get('health') || 'Good'),
          notes: String(form.get('notes') || ''),
        }
      : { ...common, targetDate: String(form.get('targetDate') || ''), summary: String(form.get('summary') || '') }
    setBusy(true)
    setError('')
    try {
      await onSave(next as Client | Project)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your changes.')
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="record-edit-dialog"
      aria-labelledby="record-editor-title"
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="record-editor-header">
        <div>
          <p>Edit details</p>
          <h2 id="record-editor-title">{client ? 'Edit client' : 'Edit project'}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close editor" disabled={busy} onClick={onClose}>
          <X size={22} />
        </button>
      </header>
      <form onSubmit={event => void submit(event)} className="record-editor-form">
        <fieldset className="form-grid record-editor-fields" disabled={busy}>
          <label className="span-2 record-name-field">
            {client ? 'Client name' : 'Project name'}
            <input
              name="name"
              defaultValue={record.name}
              required
              maxLength={200}
              readOnly={client && !canRenameClient}
              autoFocus={!client || canRenameClient}
            />
            {client && !canRenameClient && (
              <small>Only an Administrator can change the client name. You can edit the details below.</small>
            )}
          </label>
          {client ? (
            <>
              <label>
                Primary contact
                <input name="contact" defaultValue={(record as Client).contact} autoFocus={!canRenameClient} />
              </label>
              <label>
                Email
                <input type="email" name="email" defaultValue={(record as Client).email} />
              </label>
            </>
          ) : (
            <label>
              Target date
              <input type="date" name="targetDate" defaultValue={(record as Project).targetDate} />
            </label>
          )}
          <label>
            Completion status
            <select name="status" defaultValue={record.status} disabled={archived}>
              {(client ? ['Active', 'Closing', 'Closed'] : ['Discovery', 'Active', 'UAT', 'Closing', 'Closed']).map(
                status => (
                  <option key={status}>{status}</option>
                ),
              )}
            </select>
            <small>
              {archived
                ? 'Activate this record before changing its completion status.'
                : 'Choose Closed when all tasks and subtasks are done.'}
            </small>
          </label>
          {client && (
            <label>
              Health
              <select name="health" defaultValue={(record as Client).health}>
                <option>Good</option>
                <option>Watch</option>
                <option>At Risk</option>
              </select>
            </label>
          )}
          <label className="span-2">
            {client ? 'Notes' : 'Summary'}
            <textarea
              name={client ? 'notes' : 'summary'}
              rows={3}
              defaultValue={client ? (record as Client).notes : (record as Project).summary}
            />
          </label>
        </fieldset>
        {error && (
          <p className="record-editor-error" role="alert">
            {error}
          </p>
        )}
        <footer className="record-editor-footer">
          <button className="secondary" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
