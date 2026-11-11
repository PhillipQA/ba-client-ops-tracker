import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Plus, Sparkles, Trash2 } from 'lucide-react'
import { announceGeneratedDocument } from './documentDrive'
import DocumentReset from './DocumentReset'
import { useDocumentOperation } from './useDocumentOperation'
import type { Client, Project } from '../../shared/types'
import { isClosedProject } from '../tasks/lifecycle'
import { documentOutputName, suggestedDocumentStem } from './documentFilename'
import {
  emptyFsdDraft,
  fsdReference,
  fsdSectionsForModules,
  isFsdFeatureSection,
  FSD_NOTICE,
  FSD_PRESETS,
  FSD_TEMPLATE_NAME,
  type FsdDraft,
  type FsdDetails,
  type FsdPreview,
  type FsdSource,
  type FsdSourceAnalysis,
  type FsdSectionId,
  type FsdModule,
} from './fsd-model'
import { isFsdImageFile, readFsdSource } from './fsd-sources'
import FsdSourceReview, { sourceReviewLabel } from './FsdSourceReview'
import { APP_LABEL } from '../../shared/version'
import './fsd.css'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import FsdCoverage from './FsdCoverage'
import FsdReadinessChecklist from './FsdReadinessChecklist'
import { fsdReadiness } from './fsd-readiness'
import type { FsdGenerationMode } from './fsd-model'
import { migrateFsdFeatures } from './fsd-features'
import FsdFeatureFields from './FsdFeatureFields'
import { requestJson } from '../../shared/http'
function sourceId(sources: FsdSource[]) {
  return `SRC-${String(Math.max(0, ...sources.map(s => Number(s.id.replace(/^SRC-/, '')) || 0)) + 1).padStart(3, '0')}`
}
type Provider = { enabled: boolean; provider?: string; name?: string; model?: string }
const request = <T,>(path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/documents/fsd/${path}`, {
    body: body || undefined,
    signal,
    fallback: 'The FSD request failed. Your draft is retained.',
  })
export default function FsdCreation({
  clients,
  projects,
  canGenerate,
  templateReady,
  draftKey,
  active,
}: {
  clients: Client[]
  projects: Project[]
  canGenerate: boolean
  templateReady: boolean
  draftKey: string
  active: boolean
}) {
  const storageKey = `ba-fsd-v1:${draftKey}`
  const presetsKey = `ba-fsd-presets-v1:${draftKey}`
  const [draft, setDraft] = useState<FsdDraft>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        const value = JSON.parse(saved)
        if (value.details && Array.isArray(value.sources) && Array.isArray(value.customPresets))
          return migrateFsdFeatures({
            ...emptyFsdDraft(),
            ...value,
            mode: 'advanced',
            ...(value.mode === 'advanced' ? {} : { preview: null, previewRevision: -1, reviewed: false }),
          })
      }
    } catch {
      /* in-memory drafts remain available when storage is blocked */
    }
    const fresh = migrateFsdFeatures(emptyFsdDraft())
    try {
      const presets = JSON.parse(localStorage.getItem(presetsKey) || '[]')
      if (Array.isArray(presets))
        fresh.customPresets = presets
          .filter(p => typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.instructions === 'string')
          .slice(0, 30)
    } catch {}
    return fresh
  })
  const [provider, setProvider] = useState<Provider | null>(null)
  const [providerError, setProviderError] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [presetSaveError, setPresetSaveError] = useState('')
  const [showPreview, setShowPreview] = useState(Boolean(draft.preview))
  const [editPreview, setEditPreview] = useState(false)
  const [uploadKind, setUploadKind] = useState<FsdSource['kind']>('BRD')
  const [stage, setStage] = useState<'reading' | 'analysis' | 'preview' | 'export'>('reading')
  const [retryAction, setRetryAction] = useState<'upload' | 'analysis' | 'preview' | 'export'>('upload')
  const [analyzingId, setAnalyzingId] = useState('')
  const operation = useDocumentOperation()
  const fileInput = useRef<HTMLInputElement>(null)
  const draftRef = useRef(draft)
  const previewAttemptMode = useRef<FsdGenerationMode>('standard')
  draftRef.current = draft
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(draft))
      setSaveError('')
    } catch {
      setSaveError(
        'Browser storage is unavailable or full. Your draft is retained while this page stays open; refresh recovery is unavailable.',
      )
    }
  }, [draft, storageKey])
  useEffect(() => {
    try {
      localStorage.setItem(presetsKey, JSON.stringify(draft.customPresets))
      setPresetSaveError('')
    } catch {
      setPresetSaveError('Custom presets could not be saved for future sessions. They remain in this draft.')
    }
  }, [draft.customPresets, presetsKey])
  useEffect(() => {
    if (!active) return
    let alive = true
    request<Provider>('provider')
      .then(value => {
        if (alive) {
          setProvider(value)
          setProviderError('')
        }
      })
      .catch(e => {
        if (alive) {
          setProvider(null)
          setProviderError(e.message)
        }
      })
    return () => {
      alive = false
    }
  }, [active])
  useEffect(() => {
    if (!active) return
    const handoffKey = `ba-brd-handoff:${draftKey}`
    let raw = ''
    try {
      raw = sessionStorage.getItem(handoffKey) || ''
    } catch {
      return
    }
    if (!raw) return
    try {
      const handoff = JSON.parse(raw) as { name?: string; text?: string; reference?: string }
      const text = String(handoff.text || '').trim()
      if (!text) throw new Error('The BRD handoff did not contain structured BRD data.')
      const current = draftRef.current
      if (current.sources.some(source => source.kind === 'BRD' && source.text === text)) {
        sessionStorage.removeItem(handoffKey)
        return
      }
      if (
        current.sources.length >= 20 ||
        current.sources.reduce((sum, source) => sum + source.text.length, 0) + text.length > 180000
      )
        throw new Error(
          'The BRD could not be added because the FSD source limit would be exceeded. Remove an older source and use “Use in FSD Creator” again.',
        )
      const source: FsdSource = {
        id: sourceId(current.sources),
        name: String(handoff.name || handoff.reference || 'BRD Creator output').slice(0, 200),
        kind: 'BRD',
        text,
        target: '',
      }
      setDraft(value => ({
        ...value,
        sources: [...value.sources, source],
        revision: value.revision + 1,
        preview: null,
        previewRevision: -1,
        reviewed: false,
      }))
      setShowPreview(false)
      setEditPreview(false)
      setError('')
      sessionStorage.removeItem(handoffKey)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import the BRD Creator output into FSD Creation.')
    }
  }, [active, draftKey])
  useEffect(() => {
    const preventLoss = (e: BeforeUnloadEvent) => {
      if (busy || saveError) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [busy, saveError])
  const patch = (values: Partial<FsdDraft>, content = true) =>
    setDraft(d => ({
      ...d,
      ...values,
      ...(values.modules || values.features
        ? { sources: (values.sources || d.sources).map(s => ({ ...s, analysis: undefined, analysisError: undefined })) }
        : {}),
      ...(values.features ? { modules: values.features.map(f => f.id) } : {}),
      revision: content ? d.revision + 1 : d.revision,
      reviewed: content ? false : (values.reviewed ?? d.reviewed),
    }))
  const editSource = (id: string, values: Partial<FsdSource>) =>
    patch({
      sources: draft.sources.map(s =>
        s.id === id ? { ...s, ...values, analysis: undefined, analysisError: undefined } : s,
      ),
    })
  const detail = (key: keyof FsdDetails, value: string) => patch({ details: { ...draft.details, [key]: value } })
  const suggestedFileName = suggestedDocumentStem('FSD', draft.details.client, draft.projectName)
  const fileName = draft.fileNameOverride ?? suggestedFileName
  const stale =
    draft.previewRevision !== draft.revision ||
    Boolean(draft.preview && draft.preview.generationMode !== 'available' && !draft.preview.requirements?.length)
  const presets = [...FSD_PRESETS, ...draft.customPresets]
  const scopedSections = fsdSectionsForModules(draft.modules, draft.features)
  const scopedSectionIds = new Set<FsdSectionId>(scopedSections.map(([id]) => id))
  const firstPreviewModuleSectionId = draft.preview?.sections.find(section => isFsdFeatureSection(section.id))?.id
  const sourceIncluded = (source: FsdSource, modules = draft.modules) =>
    !source.target || fsdSectionsForModules(modules, draft.features).some(([id]) => id === source.target)
  const includedSources = draft.sources.filter(s => sourceIncluded(s))
  const pendingSources = includedSources.filter(s => !s.analysis || s.analysisError)
  const readiness = fsdReadiness(draft.sources, draft.modules, draft.features, draft.uploadFailures)
  const standardSourceProblems =
    Boolean(draft.uploadFailures?.length) ||
    includedSources.some(
      s => s.analysisError || (s.analysis && (!s.analysis.complete || s.analysis.readability !== 'readable')),
    ) ||
    (includedSources.length > 0 && includedSources.every(s => s.analysis && !s.analysis.requirements.length))
  const requiredDetails = {
    client: 'Client',
    feature: 'Document title',
    product: 'Product',
    author: 'Prepared by',
    date: 'Document date',
    version: 'Revision',
  } as const
  const missingDetails = (Object.keys(requiredDetails) as Array<keyof typeof requiredDetails>)
    .filter(key => !draft.details[key]?.trim())
    .map(key => requiredDetails[key])
  const date = draft.details.date
  const invalidDate =
    Boolean(date?.trim()) &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  const featureNames = (draft.features || []).map(f => f.name.trim())
  const previewPrerequisites = [
    ...(!featureNames.length ? ['Add at least one feature in Scope & section mapping'] : []),
    ...(featureNames.some(name => !name) ? ['Enter a Feature Name for every listed feature'] : []),
    ...(new Set(featureNames.map(name => name.toLowerCase())).size !== featureNames.length
      ? ['Use a different name for each custom feature']
      : []),
    ...(includedSources.length
      ? []
      : [draft.sources.length ? 'Map a source to the selected scope' : 'Add at least one source']),
    ...(missingDetails.length ? [`Complete: ${missingDetails.join(', ')}`] : []),
    ...(invalidDate ? ['Choose a valid document date'] : []),
    ...(!draft.presetInstructions.trim() ? ['Enter preset instructions'] : []),
    ...(draft.pasteText.trim() ? ['Add or clear the pasted text above so it can be reviewed'] : []),
  ]
  async function analyzeBatch(sources: FsdSource[], modules: FsdModule[], job: ReturnType<typeof operation.begin>) {
    const results: FsdSource[] = []
    for (const source of sources) {
      if (!job.isCurrent()) return results
      if (!sourceIncluded(source, modules)) {
        results.push(source)
        continue
      }
      setStage('analysis')
      setAnalyzingId(source.id)
      setBusy(`AI reviewing ${source.name}…`)
      let reviewed: FsdSource
      try {
        const { analysis: _old, analysisError: _error, ...evidence } = source
        const analysis = await request<FsdSourceAnalysis>(
          'analyze-source',
          { source: evidence, modules, features: draft.features },
          job.signal,
        )
        reviewed = { ...source, analysis, analysisError: undefined }
        if (job.isCurrent()) setProvider(p => ({ ...p, enabled: true, name: analysis.provider, model: analysis.model }))
      } catch (e) {
        reviewed = {
          ...source,
          analysis: undefined,
          analysisError: e instanceof Error ? e.message : 'Source analysis failed. Retry analysis.',
        }
      }
      if (!job.isCurrent()) return results
      results.push(reviewed)
      setDraft(d => ({
        ...d,
        sources: d.sources.map(s =>
          s.id === source.id && s.text === source.text && s.target === source.target && s.kind === source.kind
            ? reviewed
            : s,
        ),
      }))
    }
    if (job.isCurrent()) setAnalyzingId('')
    return results
  }
  async function analyzePending(sourceId?: string) {
    if (busy) return
    const sources = draft.sources.filter(
      s => sourceIncluded(s) && (sourceId ? s.id === sourceId : !s.analysis || s.analysisError),
    )
    if (!sources.length) return
    const job = operation.begin()
    setError('')
    setRetryAction('analysis')
    patch({
      sources: draft.sources.map(s =>
        sources.some(p => p.id === s.id) ? { ...s, analysis: undefined, analysisError: undefined } : s,
      ),
      preview: null,
      previewRevision: -1,
    })
    setShowPreview(false)
    setEditPreview(false)
    const results = await analyzeBatch(sources, draft.modules, job)
    if (!job.isCurrent()) return
    setError(
      results.some(s => s.analysisError)
        ? 'Some sources could not be reviewed. Open the affected source for details, then retry AI review.'
        : '',
    )
    setBusy('')
  }
  async function addFiles(files: File[]) {
    if (!files.length || busy) return
    if ((draft.uploadFailures?.length || 0) + files.length > 20) {
      setError('Dismiss older unavailable upload records before adding more files (20 records maximum).')
      return
    }
    if (draft.sources.length + files.length > 20) {
      setError('Use up to 20 sources.')
      return
    }
    const job = operation.begin()
    setError('')
    setRetryAction('upload')
    setStage('reading')
    setBusy('Reading documents…')
    const added: FsdSource[] = [],
      errors: string[] = [],
      failures: { id: string; name: string; reason: string }[] = []
    for (const file of files) {
      if (!job.isCurrent()) return
      try {
        const text = await readFsdSource(file, message => {
          if (job.isCurrent()) setBusy(message)
        })
        if (!job.isCurrent()) return
        if ([...draftRef.current.sources, ...added].reduce((sum, s) => sum + s.text.length, 0) + text.length > 180000)
          throw new Error(
            `${file.name}: sources would exceed 180,000 characters. Split the feature into smaller documents.`,
          )
        added.push({
          id: sourceId([...draftRef.current.sources, ...added]),
          name: file.name,
          kind: isFsdImageFile(file) ? 'Supporting document' : uploadKind,
          target: '',
          text,
        })
      } catch (e) {
        const reason = (e instanceof Error ? e.message : 'Document could not be read.')
          .replace(/[\u0000-\u001f]/g, ' ')
          .slice(0, 2000)
        errors.push(reason)
        failures.push({
          id: crypto.randomUUID(),
          name: file.name.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) || 'Unnamed file',
          reason,
        })
      }
    }
    if (!job.isCurrent()) return
    if (added.length || failures.length)
      setDraft(d => ({
        ...d,
        sources: [...d.sources, ...added],
        uploadFailures: [...(d.uploadFailures || []).filter(f => !added.some(s => s.name === f.name)), ...failures],
        revision: d.revision + 1,
        reviewed: false,
      }))
    const results = await analyzeBatch(added, draft.modules, job)
    if (!job.isCurrent()) return
    if (results.some(s => s.analysisError)) {
      if (!errors.length) setRetryAction('analysis')
      errors.push(
        'Some sources could not be reviewed. Extracted text is retained; open the affected source and retry AI review.',
      )
    }
    setError(errors.join('\n'))
    setBusy('')
  }
  async function generatePreview(mode: FsdGenerationMode = 'standard') {
    if (busy) return
    if (previewPrerequisites.length) return
    previewAttemptMode.current = mode
    const job = operation.begin(),
      revision = draft.revision
    setBusy('Preparing sources…')
    setStage('analysis')
    setRetryAction('preview')
    setError('')
    try {
      const reviewed = await analyzeBatch(pendingSources, draft.modules, job)
      if (!job.isCurrent()) return
      if (mode === 'standard' && reviewed.some(s => s.analysisError))
        throw new Error(
          'Some sources could not be reviewed. Retry AI review or choose Generate anyway to use successfully reviewed sources.',
        )
      const snapshot = {
        ...draft,
        sources: draft.sources.map(s => reviewed.find(r => r.id === s.id) || s),
        sourceReviewVersion: 1,
        allowIncomplete: mode === 'available',
      }
      setStage('preview')
      setBusy('Combining reviewed sources and preset into your FSD…')
      const preview = await request<FsdPreview>('preview', snapshot, job.signal)
      if (!job.isCurrent()) return
      setDraft(d => ({ ...d, preview, previewRevision: revision, reviewed: false }))
      setShowPreview(true)
      setEditPreview(false)
      setProvider(p => ({ ...p, enabled: true, name: preview.provider, model: preview.model }))
    } catch (e) {
      if (job.isCurrent()) setError(e instanceof Error ? e.message : 'Generation failed.')
    } finally {
      if (job.isCurrent()) setBusy('')
    }
  }
  async function exportFsd() {
    if (!templateReady || !draft.preview || stale || !draft.reviewed || busy) return
    const job = operation.begin()
    setBusy('Preparing Word document…')
    setStage('export')
    setRetryAction('export')
    setError('')
    try {
      const result = await request<{ fileData: string; fileName: string; mimeType: string }>(
        'generate',
        {
          details: draft.details,
          preview: draft.preview,
          reviewed: true,
          mode: 'advanced',
          sources: draft.sources,
          uploadFailures: draft.uploadFailures,
          modules: draft.modules,
          features: draft.features,
          presetInstructions: draft.presetInstructions,
          allowIncomplete: draft.preview.generationMode === 'available',
          fileName: documentOutputName(fileName, 'docx', suggestedFileName),
        },
        job.signal,
      )
      if (!job.isCurrent()) return
      const bytes = Uint8Array.from(atob(result.fileData), c => c.charCodeAt(0)),
        url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
      const a = document.createElement('a')
      a.href = url
      a.download = result.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      announceGeneratedDocument('fsd', result)
    } catch (e) {
      if (job.isCurrent()) setError(e instanceof Error ? e.message : 'Export failed.')
    } finally {
      if (job.isCurrent()) setBusy('')
    }
  }
  function reset() {
    operation.cancel()
    const next = migrateFsdFeatures(emptyFsdDraft())
    next.customPresets = draftRef.current.customPresets
    draftRef.current = next
    try {
      sessionStorage.removeItem(storageKey)
    } catch {
      /* The save effect reports storage failures. */
    }
    if (fileInput.current) fileInput.current.value = ''
    setDraft(next)
    setShowPreview(false)
    setEditPreview(false)
    setUploadKind('BRD')
    setError('')
    setBusy('')
    setSaveError('')
    setAnalyzingId('')
    setRetryAction('upload')
    setStage('reading')
  }
  function removeSource(id: string) {
    patch({ sources: draft.sources.filter(source => source.id !== id), preview: null, previewRevision: -1 })
    setShowPreview(false)
    setEditPreview(false)
    setError('')
  }
  function editBlock(sectionIndex: number, blockIndex: number, row: number, col: number, value: string) {
    setDraft(d => {
      if (!d.preview) return d
      const preview = structuredClone(d.preview),
        block = preview.sections[sectionIndex].blocks[blockIndex]
      if (block.type === 'paragraph') block.text = value
      else block.rows[row][col] = value
      return { ...d, preview, reviewed: false }
    })
  }
  async function addPaste() {
    if (!draft.pasteText.trim() || busy) return
    if (draft.sources.length >= 20 || draft.pasteText.length > 120000) {
      setError('Use up to 20 sources, each up to 120,000 characters.')
      return
    }
    if (draft.sources.reduce((sum, s) => sum + s.text.length, 0) + draft.pasteText.trim().length > 180000) {
      setError('Sources exceed 180,000 characters. Split the feature into smaller documents.')
      return
    }
    const source: FsdSource = {
      id: sourceId(draft.sources),
      name: draft.pasteName.trim() || `${draft.pasteKind} ${draft.sources.length + 1}`,
      kind: draft.pasteKind,
      target: '',
      text: draft.pasteText.trim(),
    }
    patch({ sources: [...draft.sources, source], pasteText: '', pasteName: '' })
    const job = operation.begin()
    setError('')
    setRetryAction('analysis')
    const results = await analyzeBatch([source], draft.modules, job)
    if (!job.isCurrent()) return
    setError(
      results.some(s => s.analysisError)
        ? 'Source text is retained, but AI review failed. Open the source for details and retry analysis.'
        : '',
    )
    setBusy('')
  }
  const detailsField = (key: keyof FsdDetails, label: string, type = 'text', required = false) => (
    <label key={key}>
      {label}
      {required ? ' *' : ''}
      <input
        type={type}
        maxLength={180}
        value={draft.details[key]}
        onChange={e => detail(key, e.target.value)}
        required={required}
      />
    </label>
  )
  return (
    <div className="fsd-creator">
      <div className="fsd-topline">
        <div>
          <span className="fsd-eyebrow">DOCUMENT CREATION · ADVANCED MODE</span>
          <h2>FSD Document Creator</h2>
          <p>Turn your requirements into a reviewable specification.</p>
        </div>
        <span className="fsd-template-badge">
          <FileText size={16} />
          {templateReady ? FSD_TEMPLATE_NAME : 'Template required'}
        </span>
      </div>
      <DocumentReset label="FSD" onReset={reset} disabled={!canGenerate} />
      <div className="fsd-status">
        <span>
          {provider?.enabled
            ? `Document Agent: ${provider.name} · ${provider.model}`
            : providerError || 'Configure and enable the Document Agent in Account Settings.'}
        </span>
        <span>
          {saveError ? 'Draft held in this page' : 'Draft retained in this browser tab'} · App v{APP_LABEL}
        </span>
      </div>
      {presetSaveError && (
        <p className="fsd-warning" role="status">
          {presetSaveError}
        </p>
      )}
      {saveError && (
        <p className="fsd-warning" role="status">
          {saveError}
        </p>
      )}
      {draft.sources.some(s => s.text.includes('[Extraction warning:')) && (
        <div className="fsd-alert">
          Some sources contain OCR or visual content. Review the extracted text and original images before generating
          requirements.
        </div>
      )}
      <DocumentProcessingPanel
        state={
          error
            ? 'error'
            : busy
              ? 'working'
              : draft.preview || includedSources.some(s => s.analysis)
                ? 'success'
                : 'idle'
        }
        title={
          error ? 'FSD processing failed' : busy || (draft.preview ? 'FSD preview is ready' : 'Source review available')
        }
        detail={
          error ||
          (!busy
            ? draft.preview
              ? 'Review the preview below, then generate the Word document.'
              : 'Open each source to check what the AI understood and any reading limitations. Add supporting documents and choose your preset before generating.'
            : stage === 'analysis'
              ? 'The Document Agent is checking readability and extracting supported facts for your selected scope.'
              : '')
        }
        stages={
          stage === 'reading' || stage === 'analysis'
            ? ['Reading document content', 'AI source review', 'Review findings', 'Choose preset and generate']
            : stage === 'export'
              ? [
                  'Validating reviewed preview',
                  'Mapping information to template',
                  'Generating Word document',
                  'Starting download',
                ]
              : ['Preparing reviewed sources', 'Applying preset and scope', 'Generating preview', 'Ready for review']
        }
        activeStage={stage === 'reading' ? 0 : stage === 'analysis' ? 1 : 2}
        onRetry={
          error
            ? () => {
                if (retryAction === 'upload') fileInput.current?.click()
                else if (retryAction === 'analysis') void analyzePending()
                else if (retryAction === 'export') void exportFsd()
                else void generatePreview(previewAttemptMode.current)
              }
            : undefined
        }
      />
      <fieldset disabled={!canGenerate || Boolean(busy)} className="fsd-fieldset">
        <div className="fsd-columns">
          <div className="fsd-input-column">
            <section className="fsd-card">
              <h3>1. Document details</h3>
              <div className="fsd-fields">
                <label>
                  Client *
                  <input
                    list={`fsd-clients-${draftKey}`}
                    value={draft.details.client}
                    maxLength={180}
                    onChange={e => detail('client', e.target.value)}
                  />
                  <datalist id={`fsd-clients-${draftKey}`}>
                    {[...clients]
                      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
                      .map(c => (
                        <option key={c.id} value={c.name} />
                      ))}
                  </datalist>
                </label>
                <label>
                  Project name (filename)
                  <input
                    list={`fsd-projects-${draftKey}`}
                    value={draft.projectName || ''}
                    maxLength={180}
                    onChange={e => patch({ projectName: e.target.value }, false)}
                    placeholder="Choose a project or enter its name"
                  />
                  <datalist id={`fsd-projects-${draftKey}`}>
                    {projects
                      .filter(p => !isClosedProject(p))
                      .map(p => (
                        <option key={p.id} value={p.name} />
                      ))}
                  </datalist>
                </label>
                {detailsField('feature', 'Document title', 'text', true)}
                {detailsField('product', 'Product', 'text', true)}
                {detailsField('author', 'Prepared by', 'text', true)}
                {detailsField('date', 'Document date', 'date', true)}
                {detailsField('version', 'Revision', 'text', true)}
                <label className="fsd-full">
                  Document reference
                  <input
                    value={draft.details.reference}
                    maxLength={180}
                    placeholder={fsdReference(draft.details)}
                    onChange={e => detail('reference', e.target.value)}
                  />
                </label>
                <label className="fsd-full">
                  Filename (without .docx)
                  <input
                    aria-label="FSD filename"
                    value={fileName}
                    maxLength={150}
                    onChange={e => patch({ fileNameOverride: e.target.value }, false)}
                    onBlur={() => {
                      if (!draft.fileNameOverride?.trim()) patch({ fileNameOverride: undefined }, false)
                    }}
                  />
                  <small>Download: {documentOutputName(fileName, 'docx', suggestedFileName)}</small>
                </label>
              </div>
              <details>
                <summary>Signatories</summary>
                <p>Names remain editable. Signature and date lines stay blank for approval.</p>
                <div className="fsd-fields">
                  {detailsField('irippleBA', 'iRipple Business Analyst')}
                  {detailsField('iripplePM', 'iRipple Project Manager')}
                  {detailsField('clientName1', 'Client signatory 1')}
                  {detailsField('clientTitle1', 'Position 1')}
                  {detailsField('clientName2', 'Client signatory 2')}
                  {detailsField('clientTitle2', 'Position 2')}
                </div>
              </details>
            </section>
            <section className="fsd-card">
              <h3>2. Requirements & supporting sources</h3>
              <label>
                Upload as
                <select value={uploadKind} onChange={e => setUploadKind(e.target.value as FsdSource['kind'])}>
                  {['BRD', 'Meeting notes', 'Supporting document', 'Chat'].map(k => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="fsd-dropzone">
                <Plus size={26} />
                <strong>Add BRD, screenshots, or supporting documents</strong>
                <span>PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, WEBP, BMP, TIF/TIFF · 10 MB each</span>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff"
                  onChange={e => {
                    const files = Array.from(e.target.files || []) as File[]
                    e.target.value = ''
                    void addFiles(files)
                  }}
                />
              </label>
              <small>
                Up to 20 sources / 180,000 characters total. Each added source is reviewed by your Document Agent using
                its API. PDF screenshots are read individually with English OCR; check figures, diagrams and visual
                relationships against the original. A readable result means the text could be interpreted, not that
                every requirement is correct.
              </small>
              {includedSources.length > 0 && (
                <div className="fsd-analysis-status">
                  <span>
                    {includedSources.filter(s => s.analysis && !s.analysisError).length} of {includedSources.length}{' '}
                    included sources reviewed
                  </span>
                  {pendingSources.length > 0 && (
                    <button type="button" className="secondary" onClick={() => void analyzePending()}>
                      <Sparkles size={14} />
                      Analyze pending sources ({pendingSources.length})
                    </button>
                  )}
                </div>
              )}
              <div className="fsd-source-list">
                {draft.sources.map(source => (
                  <details key={source.id}>
                    <summary>
                      <FileText size={15} />
                      <span>{source.name}</span>
                      <small>
                        {source.kind} · {source.text.length.toLocaleString()} chars
                        <br />
                        <span className="fsd-source-review-label">
                          {sourceReviewLabel(source, !sourceIncluded(source), analyzingId === source.id)}
                        </span>
                      </small>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Remove ${source.name}`}
                        onClick={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          removeSource(source.id)
                        }}
                      >
                        <Trash2 size={14} />
                        Remove
                      </button>
                    </summary>
                    <div className="fsd-source-actions">
                      <label>
                        Source type
                        <select
                          value={source.kind}
                          onChange={e => editSource(source.id, { kind: e.target.value as FsdSource['kind'] })}
                        >
                          {['BRD', 'Meeting notes', 'Supporting document', 'Chat'].map(k => (
                            <option key={k}>{k}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Map to section
                        <select value={source.target} onChange={e => editSource(source.id, { target: e.target.value })}>
                          <option value="">Shared source / AI determines applicable sections</option>
                          {source.target && !scopedSectionIds.has(source.target as FsdSectionId) && (
                            <option value={source.target}>Previous feature mapping — reassign</option>
                          )}
                          {scopedSections.map(([id, title]) => (
                            <option key={id} value={id}>
                              {title}
                            </option>
                          ))}
                        </select>
                        {source.target && !scopedSectionIds.has(source.target as FsdSectionId) && (
                          <small className="fsd-warning">
                            This source points to a removed or previous feature. Reassign it to an included section to
                            use it.
                          </small>
                        )}
                      </label>
                    </div>
                    <FsdSourceReview
                      features={draft.features}
                      source={source}
                      excluded={!sourceIncluded(source)}
                      working={analyzingId === source.id}
                      onAnalyze={() => void analyzePending(source.id)}
                    />
                    <label>
                      Review / correct extracted text
                      <textarea
                        rows={9}
                        maxLength={120000}
                        value={source.text}
                        onChange={e => editSource(source.id, { text: e.target.value })}
                      />
                    </label>
                  </details>
                ))}
              </div>
              <details className="fsd-paste" open>
                <summary>Paste meeting notes, chat or requirements</summary>
                <div className="fsd-fields">
                  <label>
                    Source name
                    <input
                      value={draft.pasteName}
                      maxLength={200}
                      placeholder="Client meeting — 21 Sep"
                      onChange={e => patch({ pasteName: e.target.value }, false)}
                    />
                  </label>
                  <label>
                    Source type
                    <select
                      value={draft.pasteKind}
                      onChange={e => patch({ pasteKind: e.target.value as FsdSource['kind'] }, false)}
                    >
                      {['BRD', 'Meeting notes', 'Supporting document', 'Chat'].map(k => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <textarea
                  aria-label="Pasted requirements"
                  placeholder="Paste the requirements here…"
                  rows={6}
                  maxLength={120000}
                  value={draft.pasteText}
                  onChange={e => patch({ pasteText: e.target.value }, false)}
                />
                <button className="secondary" disabled={!draft.pasteText.trim()} onClick={addPaste}>
                  <Plus size={15} />
                  Add to sources
                </button>
              </details>
            </section>
          </div>
          <div className="fsd-controls-column">
            <section className="fsd-card">
              <h3>3. Skills & presets</h3>
              <label>
                Preset
                <select
                  value={draft.presetId}
                  onChange={e => {
                    const preset = presets.find(p => p.id === e.target.value)!
                    patch({ presetId: preset.id, presetInstructions: preset.instructions })
                  }}
                >
                  {presets.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Customize instructions
                <textarea
                  rows={8}
                  maxLength={8000}
                  value={draft.presetInstructions}
                  onChange={e => patch({ presetInstructions: e.target.value })}
                />
              </label>
              <small>
                Choose or change your preset after reviewing sources. It guides the combined FSD and does not change the
                source facts. Unsupported details stay as questions or TBD.
              </small>
              <div className="fsd-save-preset">
                <label>
                  Save as a common preset
                  <input
                    maxLength={100}
                    placeholder="Preset name"
                    value={draft.presetName}
                    onChange={e => patch({ presetName: e.target.value }, false)}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={
                    !draft.presetName.trim() || !draft.presetInstructions.trim() || draft.customPresets.length >= 30
                  }
                  onClick={() => {
                    const preset = {
                      id: crypto.randomUUID(),
                      name: draft.presetName.trim(),
                      instructions: draft.presetInstructions,
                    }
                    patch(
                      { customPresets: [...draft.customPresets, preset], presetId: preset.id, presetName: '' },
                      false,
                    )
                  }}
                >
                  Save preset
                </button>
              </div>
              <small>Custom presets are saved for this account and user in this browser.</small>
              {draft.customPresets.some(p => p.id === draft.presetId) && (
                <button
                  className="secondary"
                  onClick={() =>
                    patch({
                      customPresets: draft.customPresets.filter(p => p.id !== draft.presetId),
                      presetId: 'standard',
                      presetInstructions: FSD_PRESETS[0].instructions,
                    })
                  }
                >
                  Delete custom preset
                </button>
              )}
            </section>
            <section className="fsd-card">
              <h3>4. Scope &amp; section mapping</h3>
              <FsdFeatureFields
                features={draft.features || []}
                client={draft.details.client}
                reservedIds={draft.sources.map(source => source.target)}
                onChange={features => patch({ features })}
              />
              <label>
                Additional skills / guidance
                <textarea
                  rows={5}
                  maxLength={10000}
                  value={draft.guidance}
                  placeholder="Terminology, known constraints, priorities…"
                  onChange={e => patch({ guidance: e.target.value })}
                />
              </label>
              <details>
                <summary>Map instructions to included template sections</summary>
                {scopedSections
                  .filter(([id]) => !['history', 'acknowledgement', 'references'].includes(id))
                  .map(([id, title]) => (
                    <label key={id}>
                      {title}
                      <textarea
                        rows={2}
                        maxLength={2000}
                        value={draft.mapping[id] || ''}
                        placeholder="Optional: sources to prioritize and details to cover"
                        onChange={e => patch({ mapping: { ...draft.mapping, [id]: e.target.value } })}
                      />
                    </label>
                  ))}
              </details>
            </section>
            <section className="fsd-card fsd-generate-card">
              <h3>5. Preview &amp; generate</h3>
              <p>
                The AI uses your reviewed facts, current preset and listed features. A few readable notes are enough to
                start a draft.
              </p>
              {previewPrerequisites.length > 0 && (
                <div className="fsd-preview-prerequisites" role="status">
                  <strong>Complete these basics before either option:</strong>
                  <ul>
                    {previewPrerequisites.map(item => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <small>Supporting documents can be incomplete. Basic document details are still required.</small>
                </div>
              )}
              {Boolean(draft.uploadFailures?.length) && (
                <details className="fsd-card">
                  <summary>Unavailable uploads ({draft.uploadFailures!.length})</summary>
                  <ul>
                    {draft.uploadFailures!.map(f => (
                      <li key={f.id}>
                        <strong>{f.name}</strong>: {f.reason}{' '}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() =>
                            patch({ uploadFailures: draft.uploadFailures!.filter(item => item.id !== f.id) })
                          }
                        >
                          Dismiss
                        </button>
                      </li>
                    ))}
                  </ul>
                  <small>
                    Retry the upload or paste its contents. Successful replacement with the same filename clears its
                    failure record.
                  </small>
                </details>
              )}
              <FsdReadinessChecklist issues={readiness} preview={stale ? null : draft.preview} />
              <button
                className="primary fsd-primary"
                disabled={Boolean(previewPrerequisites.length) || standardSourceProblems}
                onClick={() => void generatePreview()}
              >
                <Sparkles size={16} />
                {draft.preview ? 'Regenerate AI preview' : 'Generate AI preview'}
              </button>
              {standardSourceProblems && (
                <small>
                  Some uploads or reviews are unavailable, partial, or contain no supported requirements. Correct the
                  sources, or use Generate anyway below.
                </small>
              )}
              <button
                className="secondary fsd-primary"
                disabled={Boolean(previewPrerequisites.length)}
                onClick={() => void generatePreview('available')}
              >
                <Sparkles size={16} />
                Generate anyway — use available information
              </button>
              {draft.preview && (
                <button className="secondary" onClick={() => setShowPreview(v => !v)}>
                  {showPreview ? 'Hide' : 'Show'} preview
                </button>
              )}
              <small>
                Generate anyway uses verified readable portions, skips unreadable or failed source reviews, and keeps
                missing selected sections as TBD. At least one successfully reviewed readable source is needed. Review
                the partial draft before downloading it.
              </small>
              <details>
                <summary>Included template sections</summary>
                <ol>
                  {scopedSections.map(([id, title]) => (
                    <li key={id}>{title}</li>
                  ))}
                </ol>
              </details>
            </section>
          </div>
        </div>
      </fieldset>
      {showPreview && draft.preview && (
        <section className="fsd-preview-panel">
          <div className="fsd-preview-toolbar">
            <div>
              <h3>FSD Preview</h3>
              <small>
                {draft.preview.provider} · {draft.preview.model} ·{' '}
                {new Date(draft.preview.generatedAt).toLocaleString()}
              </small>
            </div>
            <button
              className="secondary"
              disabled={!canGenerate || Boolean(busy) || stale}
              onClick={() => setEditPreview(v => !v)}
            >
              {editPreview ? 'Finish editing' : 'Edit preview'}
            </button>
          </div>
          {stale && <p className="fsd-warning">Inputs changed after this preview. Regenerate before exporting.</p>}
          {draft.preview.generationMode === 'available' && (
            <div className="fsd-warning" role="status">
              <strong>Partial draft — generated using available information.</strong>
              <p>
                Missing details remain TBD / Pending information. Review the pending questions before using this
                specification.
              </p>
              {draft.preview.sourceCoverage && (
                <>
                  <p>
                    {draft.preview.sourceCoverage.usedSourceIds.length} source(s) reviewed successfully;{' '}
                    {draft.preview.sourceCoverage.partialSourceIds.length} read in part;{' '}
                    {draft.preview.sourceCoverage.skippedSources.length} skipped.
                  </p>
                  {draft.preview.sourceCoverage.skippedSources.length > 0 && (
                    <ul>
                      {draft.preview.sourceCoverage.skippedSources.map(source => (
                        <li key={source.id}>
                          {source.name}: {source.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
          <FsdCoverage preview={draft.preview} sources={draft.sources} />
          <details className="fsd-card">
            <summary>Review interpreted requirements and source evidence</summary>
            <p>
              Excerpts are checked against source text. Confirm that the interpretation and feature classification are
              correct.
            </p>
            {draft.preview.requirements?.map(r => (
              <article key={r.id}>
                <strong>
                  {r.id} · {draft.features?.find(f => f.id === r.module)?.name || r.module}
                </strong>
                <p>{r.requirement}</p>
                {r.evidence.map((e, i) => (
                  <blockquote key={i}>
                    <small>{e.sourceId}</small>
                    <p>{e.quote}</p>
                  </blockquote>
                ))}
              </article>
            ))}
            {draft.preview.interpretationGaps?.map((g, i) => (
              <p key={i}>{g}</p>
            ))}
          </details>
          <div className="fsd-paper">
            <div className="fsd-paper-header">
              <strong>iRipple</strong>
              <b>FEATURE SPECIFICATION DOCUMENT</b>
              <small>
                Document Version:
                <br />
                {fsdReference(draft.details)}
              </small>
            </div>
            <div className="fsd-cover">
              <h2>{draft.details.product}</h2>
              <h2>{draft.details.feature}</h2>
              <p>Agreed and Approved by:</p>
              <div className="fsd-signatories">
                <div>
                  <b>IRIPPLE, INC.</b>
                  <p>{draft.details.irippleBA || 'Name'} — Business Analyst</p>
                  <p>{draft.details.iripplePM || 'Name'} — Project Manager</p>
                </div>
                <div>
                  <b>{draft.details.client}</b>
                  <p>
                    {draft.details.clientName1 || 'Name'} — {draft.details.clientTitle1 || 'Position'}
                  </p>
                  <p>
                    {draft.details.clientName2 || 'Name'} — {draft.details.clientTitle2 || 'Position'}
                  </p>
                </div>
              </div>
              <small>Signature and date lines are left blank in the Word document.</small>
            </div>
            <details>
              <summary>Proprietary Data Notice</summary>
              <p className="fsd-preserve">{FSD_NOTICE}</p>
            </details>
            <details>
              <summary>Table of Contents</summary>
              {draft.preview.sections.map(section => (
                <p key={section.id}>{section.title}</p>
              ))}
            </details>
            {draft.preview.sections.map((section, si) => (
              <section className="fsd-preview-section" key={section.id}>
                {section.id === 'summary' && <h2>1. Introduction</h2>}
                {section.id === firstPreviewModuleSectionId && <h2>5. Software Features</h2>}
                {section.id === 'assumptions' && <h2>VI. Assumptions and Limitations</h2>}
                <h3>{section.title}</h3>
                <small className="fsd-source-citation">
                  {section.sourceIds.length
                    ? `Sources: ${section.sourceIds.map(id => draft.sources.find(s => s.id === id)?.name || id).join(', ')}`
                    : 'Document metadata / review item'}
                </small>
                {section.blocks.map((block, bi) =>
                  block.type === 'paragraph' ? (
                    editPreview ? (
                      <textarea
                        key={bi}
                        disabled={Boolean(busy) || !canGenerate || stale}
                        aria-label={section.title}
                        rows={Math.min(20, Math.max(3, block.text.split('\n').length + 2))}
                        maxLength={16000}
                        value={block.text}
                        onChange={e => editBlock(si, bi, 0, 0, e.target.value)}
                      />
                    ) : (
                      <p className="fsd-preserve" key={bi}>
                        {block.text}
                      </p>
                    )
                  ) : (
                    <div className="fsd-table-scroll" key={bi}>
                      <table>
                        <thead>
                          <tr>
                            {block.headers.map((header, hi) => (
                              <th key={hi}>{header}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {block.rows.map((row, ri) => (
                            <tr key={ri}>
                              {row.map((cell, ci) => (
                                <td key={ci}>
                                  {editPreview ? (
                                    <textarea
                                      disabled={Boolean(busy) || !canGenerate || stale}
                                      aria-label={`${section.title}, ${block.headers[ci]}, row ${ri + 1}`}
                                      rows={3}
                                      maxLength={8000}
                                      value={cell}
                                      onChange={e => editBlock(si, bi, ri, ci, e.target.value)}
                                    />
                                  ) : (
                                    <span className="fsd-preserve">{cell}</span>
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ),
                )}
              </section>
            ))}
            {(draft.preview.gaps.length > 0 || draft.preview.conflicts.length > 0) && (
              <section className="fsd-review-items">
                <h3>Review Items — Pending Confirmation</h3>
                {draft.preview.gaps.length > 0 && (
                  <>
                    <h4>Missing information</h4>
                    <ul>
                      {draft.preview.gaps.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </>
                )}
                {draft.preview.conflicts.length > 0 && (
                  <>
                    <h4>Conflicting sources</h4>
                    <ul>
                      {draft.preview.conflicts.map((g, i) => (
                        <li key={i}>{g}</li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
          </div>
          <div className="fsd-export">
            <label>
              <input
                type="checkbox"
                checked={draft.reviewed}
                disabled={stale || Boolean(busy) || !canGenerate}
                onChange={e => patch({ reviewed: e.target.checked }, false)}
              />
              I reviewed this preview and any pending confirmations. This does not record client approval.
            </label>
            <button
              className="primary"
              disabled={stale || !draft.reviewed || Boolean(busy) || !canGenerate || !templateReady}
              onClick={() => void exportFsd()}
            >
              <Download size={16} />
              Generate & Download FSD (.docx)
            </button>
            <small>
              {templateReady
                ? 'Word export follows the template selected in Settings → Templates. Update the table of contents in Word for final page numbers.'
                : 'An Administrator must configure or restore the FSD template in Settings → Templates before export.'}
            </small>
          </div>
        </section>
      )}
      <div className="fsd-draft-footer">
        <small>
          Your entries remain when switching modules. Reset clears the saved draft in this tab. Saved custom presets
          remain available.
        </small>
      </div>
    </div>
  )
}
