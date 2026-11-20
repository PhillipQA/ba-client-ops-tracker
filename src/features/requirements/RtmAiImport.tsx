import { useEffect, useRef, useState } from 'react'
import { FileText, Sparkles, Trash2, X } from 'lucide-react'
import DocumentProcessingPanel from '../documents/DocumentProcessingPanel'
import {
  applyRtmAiSelection,
  matchingRequirements,
  RTM_SOURCE_KINDS,
  validateRtmSources,
  type RtmAiCandidate,
  type RtmAiPreview,
  type RtmAiSource,
  type RtmSourceKind,
} from './rtm-ai'
import { readRtmAiSource } from './rtm-ai-sources'
import type { RtmMatrix } from './rtm'
import { requestJson } from '../../shared/http'
import { useModalDialog } from '../../shared/ui/useModalDialog'

type Provider = { enabled: boolean; name?: string; provider?: string; model?: string }
const request = <T,>(path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/requirements/ai/${path}`, {
    body: body || undefined,
    signal,
    fallback: 'The Document Agent request failed. Nothing was saved.',
  })
export default function RtmAiImport({
  matrix,
  onSave,
  onClose,
}: {
  matrix: RtmMatrix
  onSave: (matrix: RtmMatrix) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    controller = useRef<AbortController | null>(null),
    mounted = useRef(true)
  const [sources, setSources] = useState<RtmAiSource[]>([]),
    [kind, setKind] = useState<RtmSourceKind>('BRD')
  const [provider, setProvider] = useState<Provider | null>(null),
    [providerError, setProviderError] = useState(''),
    [providerBusy, setProviderBusy] = useState(false)
  const [preview, setPreview] = useState<RtmAiPreview | null>(null),
    [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [consent, setConsent] = useState(false),
    [reviewed, setReviewed] = useState(false)
  const [pasteName, setPasteName] = useState(''),
    [pasteText, setPasteText] = useState('')
  useModalDialog(dialog)
  useEffect(() => {
    mounted.current = true
    void refreshProvider()
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (sources.length || busy) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [sources.length, busy])
  const close = () => {
    if (busy) return
    if (
      !sources.length ||
      window.confirm('Close and discard this unsaved AI import draft? No RTM changes will be made.')
    )
      onClose()
  }
  async function refreshProvider() {
    setProviderBusy(true)
    setProviderError('')
    setConsent(false)
    try {
      const value = await request<Provider>('provider')
      if (mounted.current) setProvider(value)
    } catch (e) {
      if (mounted.current) {
        setProvider(null)
        setProviderError((e as Error).message)
      }
    } finally {
      if (mounted.current) setProviderBusy(false)
    }
  }
  const updateSources = (next: RtmAiSource[]) => {
    setSources(next)
    setPreview(null)
    setSelected([])
    setReviewed(false)
    setConsent(false)
    setError('')
  }
  async function addFiles(files: File[]) {
    if (busy || !files.length) return
    if (sources.length + files.length > 12) {
      setError('Use up to 12 source documents.')
      return
    }
    setBusy('Reading documents…')
    setError('')
    const added: RtmAiSource[] = [],
      errors: string[] = []
    for (const file of files) {
      try {
        const text = await readRtmAiSource(file, message => {
          if (mounted.current) setBusy(message)
        })
        const next = { id: crypto.randomUUID(), name: file.name.slice(0, 200), kind, text }
        validateRtmSources([...sources, ...added, next])
        added.push(next)
      } catch (e) {
        errors.push(`${file.name}: ${(e as Error).message}`)
      }
      if (!mounted.current) return
    }
    if (added.length) updateSources([...sources, ...added])
    setError(errors.join('\n'))
    setBusy('')
  }
  function addPaste() {
    try {
      const next = [
        ...sources,
        { id: crypto.randomUUID(), name: pasteName.trim() || `${kind} pasted text`, kind, text: pasteText.trim() },
      ]
      validateRtmSources(next)
      updateSources(next)
      setPasteText('')
      setPasteName('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function generate() {
    if (busy) return
    if (pasteText.trim()) {
      setError('Add the pasted text to Sources first so it is included.')
      return
    }
    try {
      validateRtmSources(sources)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    if (!provider?.enabled || !consent) {
      setError('Enable Document Agent and confirm the source destination.')
      return
    }
    setBusy('Document Agent is mapping requirements and references…')
    setError('')
    setPreview(null)
    setSelected([])
    setReviewed(false)
    const abort = new AbortController()
    controller.current = abort
    const timeout = window.setTimeout(() => abort.abort(), 195000)
    try {
      const result = await request<RtmAiPreview>(
        'preview',
        {
          sources,
          matrixId: matrix.id,
          matrixRevision: matrix.revision,
          consent,
          provider: provider.provider,
          model: provider.model,
        },
        abort.signal,
      )
      if (mounted.current) setPreview(result)
    } catch (e) {
      if (mounted.current)
        setError(
          abort.signal.aborted
            ? 'Mapping timed out. Nothing was saved. Try fewer sources; the provider may still charge for its request.'
            : (e as Error).message,
        )
    } finally {
      window.clearTimeout(timeout)
      if (mounted.current) setBusy('')
      controller.current = null
    }
  }
  const editRow = (key: string, values: Partial<RtmAiCandidate>) => {
    setPreview(p => p && { ...p, candidates: p.candidates.map(r => (r.key === key ? { ...r, ...values } : r)) })
    setReviewed(false)
  }
  async function save() {
    if (!preview || busy) return
    setError('')
    setBusy('Saving reviewed mapping…')
    try {
      const next = applyRtmAiSelection(matrix, preview, selected, reviewed)
      await onSave(next)
      onClose()
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message)
        setBusy('')
      }
    }
  }
  const stale = preview && preview.matrixRevision !== matrix.revision
  return (
    <dialog
      className="rtm-dialog rtm-ai-dialog"
      ref={dialog}
      aria-label="Document Agent RTM import"
      onCancel={e => {
        e.preventDefault()
        close()
      }}
    >
      <header>
        <div>
          <span className="rtm-eyebrow">AI-ASSISTED RTM</span>
          <h2>
            <Sparkles size={20} /> Document Agent
          </h2>
        </div>
        <button className="icon-button" disabled={Boolean(busy)} onClick={close} aria-label="Close AI import">
          <X size={21} />
        </button>
      </header>
      <p>
        Map your own BRD, FSD and test-case documents into <strong>{matrix.name}</strong>. Review every proposal before
        adding it. No tasks, task links, assignments or completed statuses are created.
      </p>
      <div className="rtm-ai-provider">
        <span>
          {providerBusy
            ? 'Loading agent settings…'
            : provider?.enabled
              ? `${provider.name} · ${provider.model}`
              : providerError || 'The Document Agent isn’t available for this account. Internal Admin sets up AI and turns it on for each account.'}
        </span>
        <button
          className="secondary compact"
          disabled={Boolean(busy) || providerBusy}
          onClick={() => void refreshProvider()}
        >
          Refresh agent
        </button>
      </div>
      <DocumentProcessingPanel
        state={error ? 'error' : busy ? 'working' : 'idle'}
        title={error ? 'Check the import' : busy}
        detail={error || 'Keep this dialog open. Nothing is added until you approve the preview.'}
        stages={['Read source documents', 'Map requirements & references', 'Review proposals', 'Add approved rows']}
        activeStage={busy.startsWith('Saving') ? 3 : busy.startsWith('Reading') ? 0 : 1}
      />
      <fieldset className="rtm-ai-fieldset" disabled={Boolean(busy)}>
        <section className="rtm-ai-section">
          <h3>1. Add your documents</h3>
          <div className="rtm-ai-upload">
            <label>
              Document type
              <select value={kind} onChange={e => setKind(e.target.value as RtmSourceKind)}>
                {RTM_SOURCE_KINDS.map(k => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="rtm-ai-file">
              <FileText size={20} />
              <span>Add files</span>
              <input
                aria-label="Upload RTM source documents"
                type="file"
                multiple
                accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json"
                onChange={e => {
                  const files = Array.from(e.target.files || [])
                  e.target.value = ''
                  void addFiles(files)
                }}
              />
            </label>
          </div>
          <p className="rtm-hint">
            PDF, DOCX, TXT, MD, CSV, JSON: 10 MB each. XLSX: 5 MB, all worksheets including hidden sheets. Up to 12
            sources / 180,000 characters total. Review the extracted text; diagrams and embedded images are not
            interpreted. Scanned PDFs use English OCR.
          </p>
          <div className="rtm-ai-sources">
            {sources.map(source => (
              <details key={source.id}>
                <summary>
                  {source.name}{' '}
                  <small>
                    {source.kind} · {source.text.length.toLocaleString()} characters
                  </small>
                </summary>
                <div className="rtm-ai-source-actions">
                  <label>
                    Source type
                    <select
                      value={source.kind}
                      onChange={e =>
                        updateSources(
                          sources.map(s => (s.id === source.id ? { ...s, kind: e.target.value as RtmSourceKind } : s)),
                        )
                      }
                    >
                      {RTM_SOURCE_KINDS.map(k => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary compact"
                    onClick={() => updateSources(sources.filter(s => s.id !== source.id))}
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                </div>
                <label>
                  Review / correct extracted text
                  <textarea
                    rows={7}
                    maxLength={120000}
                    value={source.text}
                    onChange={e =>
                      updateSources(sources.map(s => (s.id === source.id ? { ...s, text: e.target.value } : s)))
                    }
                  />
                </label>
              </details>
            ))}
          </div>
          <details>
            <summary>Or paste document text</summary>
            <label>
              Source name
              <input maxLength={200} value={pasteName} onChange={e => setPasteName(e.target.value)} />
            </label>
            <label>
              Source text
              <textarea rows={5} maxLength={120000} value={pasteText} onChange={e => setPasteText(e.target.value)} />
            </label>
            <button className="secondary" disabled={!pasteText.trim()} onClick={addPaste}>
              Add pasted source as {kind}
            </button>
          </details>
        </section>
        <section className="rtm-ai-section">
          <h3>2. Generate mapping preview</h3>
          <label className="rtm-checkbox">
            <input
              type="checkbox"
              checked={consent}
              disabled={!provider?.enabled}
              onChange={e => setConsent(e.target.checked)}
            />
            I confirm these documents belong to this client/project and may be sent to{' '}
            {provider?.name || 'the configured provider'} ({provider?.model || 'Document Agent model'}).
          </label>
          <p className="rtm-hint">
            Extracted text, this RTM’s existing requirement summaries, and its client/project names go to this account’s
            Document Agent. Provider charges may apply. Original files stay in your browser; accepted source excerpts
            and references are saved with the RTM. This unsaved draft is lost when closed or refreshed.
          </p>
          <button
            className="primary"
            disabled={!sources.length || !provider?.enabled || !consent || providerBusy}
            onClick={() => void generate()}
          >
            <Sparkles size={16} />
            {preview ? 'Regenerate mapping' : 'Generate mapping preview'}
          </button>
        </section>
        {preview && (
          <section className="rtm-ai-section">
            <h3>3. Review proposals</h3>
            <p>
              {preview.candidates.length} proposal{preview.candidates.length === 1 ? '' : 's'} · {preview.provider} ·{' '}
              {preview.model}. Source quotations are checked against the extracted text; semantic mappings still need
              your review. This is not a guarantee of complete coverage.
            </p>
            {stale && (
              <p className="rtm-error" role="alert">
                This RTM changed after the preview. Generate a fresh mapping before saving.
              </p>
            )}
            {preview.gaps.length > 0 && (
              <details open>
                <summary>Coverage gaps / missing information ({preview.gaps.length})</summary>
                <ul>
                  {preview.gaps.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </details>
            )}
            {preview.conflicts.length > 0 && (
              <details open className="rtm-ai-warning">
                <summary>Conflicts to resolve ({preview.conflicts.length})</summary>
                <ul>
                  {preview.conflicts.map((g, i) => (
                    <li key={i}>{g}</li>
                  ))}
                </ul>
              </details>
            )}
            {!preview.candidates.length && (
              <p>No requirements were proposed. Check the extracted text and gaps, then retry.</p>
            )}
            {preview.candidates.length > 0 && (
              <div className="rtm-ai-select">
                <button
                  className="secondary compact"
                  onClick={() => {
                    setSelected(preview.candidates.map(r => r.key))
                    setReviewed(false)
                  }}
                >
                  Select all
                </button>
                <button
                  className="secondary compact"
                  onClick={() => {
                    setSelected([])
                    setReviewed(false)
                  }}
                >
                  Deselect all
                </button>
                <span>{selected.length} selected</span>
              </div>
            )}
            <div className="rtm-ai-candidates">
              {preview.candidates.map((row, i) => {
                const matches = matchingRequirements(matrix, row)
                return (
                  <article key={row.key} className={selected.includes(row.key) ? 'selected' : ''}>
                    <label className="rtm-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.includes(row.key)}
                        onChange={e => {
                          setSelected(e.target.checked ? [...selected, row.key] : selected.filter(k => k !== row.key))
                          setReviewed(false)
                        }}
                      />
                      <strong>
                        {i + 1}. {row.title}
                      </strong>
                    </label>
                    {row.warnings.length > 0 && (
                      <ul className="rtm-ai-warning">
                        {row.warnings.map((w, n) => (
                          <li key={n}>{w}</li>
                        ))}
                      </ul>
                    )}
                    {matches.length > 0 && (
                      <p className="rtm-ai-warning">
                        Possible existing match: {matches.map(m => m.code + ' — ' + m.title).join('; ')}. Choose Add
                        references or skip to avoid duplicates.
                      </p>
                    )}
                    <label>
                      Action
                      <select
                        value={row.existingRequirementId}
                        onChange={e => editRow(row.key, { existingRequirementId: e.target.value })}
                      >
                        <option value="">Create new requirement</option>
                        {matrix.requirements.map(r => (
                          <option key={r.id} value={r.id}>
                            Add references to {r.code} — {r.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    {row.existingRequirementId ? (
                      <p className="rtm-hint">
                        Only source evidence and Documentation/FSD/Testing references are appended. Existing title,
                        details, parent, priority, stage statuses, overrides and task links stay unchanged.
                      </p>
                    ) : (
                      <div className="form-grid">
                        <label className="span-2">
                          Requirement title
                          <input
                            maxLength={500}
                            value={row.title}
                            onChange={e => editRow(row.key, { title: e.target.value })}
                          />
                        </label>
                        <label>
                          Priority
                          <select
                            value={row.priority}
                            onChange={e => editRow(row.key, { priority: e.target.value as RtmAiCandidate['priority'] })}
                          >
                            {['Low', 'Medium', 'High', 'Urgent'].map(p => (
                              <option key={p}>{p}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Parent procedure
                          <select value={row.parentKey} onChange={e => editRow(row.key, { parentKey: e.target.value })}>
                            <option value="">Top level</option>
                            {preview.candidates
                              .filter(r => r.key !== row.key)
                              .map(r => (
                                <option key={r.key} value={r.key}>
                                  {r.title}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="span-2">
                          Details / acceptance criteria
                          <textarea
                            rows={3}
                            maxLength={12000}
                            value={row.description}
                            onChange={e => editRow(row.key, { description: e.target.value })}
                          />
                        </label>
                      </div>
                    )}
                    {row.matchReason && (
                      <p>
                        <strong>Mapping explanation:</strong> {row.matchReason}
                      </p>
                    )}
                    <details>
                      <summary>Source evidence & mapped references ({row.evidence.length})</summary>
                      {row.evidence.map((e, n) => (
                        <div className="rtm-ai-evidence" key={n}>
                          <strong>
                            {e.kind} → {e.kind === 'BRD' ? 'Documentation' : e.kind === 'FSD' ? 'FSD' : 'Testing'}
                          </strong>
                          <small>
                            {e.name} · {e.reference || 'No section/code in source'}
                          </small>
                          <blockquote>{e.excerpt}</blockquote>
                        </div>
                      ))}
                    </details>
                  </article>
                )
              })}
            </div>
            <label className="rtm-checkbox rtm-ai-review">
              <input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed the
              selected requirements, reference mappings, gaps and conflicts. These are references—not proof that work is
              complete.
            </label>
          </section>
        )}
      </fieldset>
      <footer className="rtm-dialog-actions">
        <button className="secondary" disabled={Boolean(busy)} onClick={close}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={
            Boolean(busy) || !preview || !selected.length || !reviewed || Boolean(stale) || Boolean(pasteText.trim())
          }
          onClick={() => void save()}
        >
          {busy.startsWith('Saving')
            ? 'Saving…'
            : `Add ${selected.length} reviewed row${selected.length === 1 ? '' : 's'}`}
        </button>
      </footer>
    </dialog>
  )
}
