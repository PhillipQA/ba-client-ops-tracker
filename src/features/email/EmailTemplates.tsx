import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { FileText, Plus, Search, Trash2, Users, UserRound, X } from 'lucide-react'
import { emailStore, TEMPLATE_LIMITS, type EmailTemplate, type TemplateDraft } from './emailStore'
import { useModalDialog } from '../../shared/ui/useModalDialog'

const byName = (a: EmailTemplate, b: EmailTemplate) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
const blank: TemplateDraft = { name: '', subject: '', body: '', shared: true }

/**
 * Create, view, edit and delete email templates. Shared templates are for the whole account and anyone who can send
 * email may change them; "Only me" templates stay private to their creator. Opened from New email (with "Use") or Work Hub.
 */
export function EmailTemplatesManager({ userId, canWrite, onClose, onUse, startWith }: { userId: string; canWrite: boolean; onClose: () => void; onUse?: (template: EmailTemplate) => void; startWith?: Partial<TemplateDraft> }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>(startWith ? 'new' : '')
  const [draft, setDraft] = useState<TemplateDraft>({ ...blank, ...startWith })
  const [saved, setSaved] = useState<TemplateDraft>({ ...blank, ...startWith })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [note, setNote] = useState('')
  const changed = JSON.stringify(draft) !== JSON.stringify(saved) || (selected === 'new' && Boolean(draft.name || draft.subject || draft.body))

  useModalDialog(dialog)
  const load = async () => {
    try { const result = await emailStore.templates(); setTemplates(result.templates.sort(byName)); setLoadError('') }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Templates could not be loaded.'); setTemplates([]) }
  }
  useEffect(() => { void load() }, [])

  const current = templates?.find(template => template.id === selected)
  const editable = selected === 'new' ? canWrite : Boolean(current?.canEdit)
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (templates || []).filter(template => words.every(word => `${template.name} ${template.subject} ${template.body}`.toLowerCase().includes(word)))
  }, [templates, query])

  const leave = (next: () => void) => { if (!changed || window.confirm('Discard the changes to this template?')) next() }
  const open = (template: EmailTemplate) => leave(() => {
    const values = { name: template.name, subject: template.subject, body: template.body, shared: template.shared }
    setSelected(template.id); setDraft(values); setSaved(values); setError(''); setNote('')
  })
  const startNew = () => leave(() => { setSelected('new'); setDraft(blank); setSaved(blank); setError(''); setNote('') })
  const close = () => leave(onClose)

  const save = async () => {
    if (busy) return
    if (!draft.name.trim()) return setError('Give the template a name.')
    if (!draft.subject.trim() && !draft.body.trim()) return setError('Add a subject or a message.')
    setBusy(true); setError(''); setNote('')
    try {
      const result = selected === 'new' ? await emailStore.create(draft) : await emailStore.update(selected, draft)
      const template = result.template, values = { name: template.name, subject: template.subject, body: template.body, shared: template.shared }
      setTemplates(list => [...(list || []).filter(item => item.id !== template.id), template].sort(byName))
      setSelected(template.id); setDraft(values); setSaved(values); setNote(selected === 'new' ? 'Template created.' : 'Changes saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'The template could not be saved.') }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!current || busy) return
    if (!window.confirm(`Delete the template “${current.name}”?${current.shared ? ' It is shared, so it is removed for everyone.' : ''} This cannot be undone.`)) return
    setBusy(true); setError('')
    try {
      await emailStore.remove(current.id)
      setTemplates(list => (list || []).filter(item => item.id !== current.id))
      setSelected(''); setDraft(blank); setSaved(blank); setNote('Template deleted.')
    } catch (e) { setError(e instanceof Error ? e.message : 'The template could not be deleted.') }
    finally { setBusy(false) }
  }

  return <dialog ref={dialog} className="modal email-templates" aria-labelledby={titleId} aria-modal="true" onCancel={event => { event.preventDefault(); close() }}>
    <div className="modal-head"><div><h2 id={titleId}><FileText size={18} aria-hidden="true" /> Email templates</h2>
      <p>Ready-made emails for clients and teammates. Shared templates are for everyone on the account; “Only me” templates are just for you.</p></div>
      <button className="icon-button" type="button" aria-label="Close templates" onClick={close}><X size={20} /></button></div>
    <div className="email-templates-body">
      <aside className="email-templates-list" aria-label="Templates">
        <div className="email-templates-tools">
          <label className="email-templates-find"><Search size={14} aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search templates" aria-label="Search templates" /></label>
          {canWrite && <button type="button" className="primary compact" onClick={startNew}><Plus size={14} aria-hidden="true" /> New template</button>}
        </div>
        {templates === null && <p role="status" className="email-templates-empty">Loading templates…</p>}
        {loadError && <p role="alert" className="email-error">{loadError}</p>}
        {templates !== null && !loadError && !shown.length && <p className="email-templates-empty">{query ? 'No template matches.' : canWrite ? 'No templates yet. Click New template to make the first one.' : 'No templates yet.'}</p>}
        <ul>{shown.map(template => <li key={template.id}>
          <button type="button" className={template.id === selected ? 'selected' : ''} aria-current={template.id === selected} onClick={() => open(template)}>
            <strong>{template.name}</strong>
            <small>{template.shared ? <><Users size={12} aria-hidden="true" /> Shared</> : <><UserRound size={12} aria-hidden="true" /> Only me</>}{template.subject ? ` · ${template.subject}` : ''}</small>
          </button>
        </li>)}</ul>
      </aside>
      <section className="email-templates-editor" aria-label={selected === 'new' ? 'New template' : current ? current.name : 'Template'}>
        {!selected && <div className="email-templates-placeholder"><FileText size={28} aria-hidden="true" /><p>Choose a template to view{canWrite ? ', edit or use it, or click New template.' : ' or use it.'}</p></div>}
        {(selected === 'new' || current) && <form className="email-fields" onSubmit={event => { event.preventDefault(); void save() }}>
          <label>Template name<input value={draft.name} maxLength={TEMPLATE_LIMITS.name} readOnly={!editable} autoFocus={selected === 'new'} placeholder="Go-live reminder" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>Subject<input value={draft.subject} maxLength={TEMPLATE_LIMITS.subject} readOnly={!editable} onChange={event => setDraft({ ...draft, subject: event.target.value })} /></label>
          <label>Message<textarea rows={10} value={draft.body} maxLength={TEMPLATE_LIMITS.body} readOnly={!editable} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
          <fieldset className="email-templates-share" disabled={!editable}><legend>Who can use it</legend>
            <label><input type="radio" name="share" checked={draft.shared} onChange={() => setDraft({ ...draft, shared: true })} /> Shared with everyone on the account</label>
            <label><input type="radio" name="share" checked={!draft.shared} disabled={Boolean(current && current.shared && current.createdBy !== userId)} title={current && current.shared && current.createdBy !== userId ? 'Only the person who made it can stop sharing it' : undefined} onChange={() => setDraft({ ...draft, shared: false })} /> Only me</label>
          </fieldset>
          {current && <p className="email-templates-meta">Made by {current.createdByName || 'someone'}{current.updatedByName && current.updatedByName !== current.createdByName ? `, last changed by ${current.updatedByName}` : ''}.{!editable ? ' You can use it but not change it.' : ''}</p>}
          <small className="email-templates-meta">Your signature is added under the message when you use a template.</small>
          {error && <p role="alert" className="email-error">{error}</p>}
          {note && !error && <p role="status" className="email-note">{note}</p>}
          <div className="email-templates-actions">
            {current && editable && <button type="button" className="secondary danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" /> Delete</button>}
            <span className="email-templates-spacer" />
            {onUse && current && <button type="button" className="secondary" disabled={busy || changed} title={changed ? 'Save or discard your changes first' : undefined} onClick={() => onUse(current)}>Use in this email</button>}
            {editable && <button type="submit" className="primary" disabled={busy || !changed}>{busy ? 'Saving…' : selected === 'new' ? 'Create template' : 'Save changes'}</button>}
          </div>
        </form>}
      </section>
    </div>
  </dialog>
}
