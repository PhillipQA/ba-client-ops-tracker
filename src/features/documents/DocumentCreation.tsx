import BrdCreation from './BrdCreation'
import FsdCreation from './FsdCreation'
import TestCaseCreation from './TestCaseCreation'
import SignOffCreation from './SignOffCreation'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import DocumentReset from './DocumentReset'
import { useDocumentOperation } from './useDocumentOperation'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'
import { PersonNameInput } from '../../shared/ui/PersonNameInput'
import { knownPeople } from '../../shared/knownPeople'
import { DocHubOptions, DocHubResult, DocHubHistory, useDocHubDraft } from './DocHubPanel'
import { LinkedEmails } from './LinkedEmails'
import { documentOutputName, suggestedDocumentStem } from './documentFilename'
import { SIGNOFF_FORM_TYPES, SIGNOFF_TEMPLATE_KIND, type SignoffFormType, type SignoffTemplateKind } from './signoff'
import { useEffect, useMemo, useRef, useState } from 'react'
import { extractCorLocally, extractCorTextLocally } from './corOcr'
import { DriveFilePicker, SaveToDriveBar, useDocumentDrive } from './documentDrive'
import {
  BriefcaseBusiness,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  Download,
  FileCog,
  FileText,
  Plus,
  ScanLine,
  Trash2,
  UserRound,
} from 'lucide-react'

type DocumentFlow = 'drf' | 'brd' | 'fsd' | 'testcase' | 'signoff'

type Signatory = {
  email?: string
  label: string
  name: string
  title: string
}

type PosRow = {
  id: string
  computerName: string
  serialNo: string
  brand: string
  model: string
}

const COR_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.bmp,.docx'
const MAX_COR_BYTES = 12 * 1024 * 1024
const MAX_POS_ROWS = 17
const REQUEST_FOR_OPTIONS = [
  'POS PERMIT APPLICATION ONLY',
  'BARTER LICENSE',
  'BXI LICENSE',
  'TEMPORARY LICENSE FOR BXI',
]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function todayMmDdYyyy() {
  const date = new Date()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${date.getFullYear()}`
}

function downloadBase64File(base64: string, mimeType: string, filename: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string
    diagnosticId?: string
    loggingUnavailable?: boolean
  } & T
  if (!response.ok)
    throw Object.assign(new Error(payload.error || 'Document request failed.'), {
      diagnosticId: payload.diagnosticId,
      loggingUnavailable: payload.loggingUnavailable,
    })
  return payload
}

function FileSummary({ files, onRemove, disabled }: { files: File[]; onRemove: () => void; disabled: boolean }) {
  if (!files.length) return null
  return (
    <div className="document-file-list">
      {files.map((file, index) => (
        <div className="document-file-row" key={`${file.name}-${file.size}-${index}`}>
          <FileText size={16} />
          <div>
            <strong>{file.name}</strong>
            <span>
              {formatBytes(file.size)} · {file.type || 'Unknown type'}
            </span>
          </div>
          <button
            type="button"
            className="secondary compact"
            disabled={disabled}
            aria-label={`Remove ${file.name}`}
            onClick={onRemove}
          >
            <Trash2 size={15} />
            Remove
          </button>
        </div>
      ))}
    </div>
  )
}

function newPosRow(): PosRow {
  return { id: crypto.randomUUID(), computerName: '', serialNo: '', brand: '', model: '' }
}

const defaultSignatories: Signatory[] = [
  { label: 'Prepared By', name: '', title: '' },
  { label: 'Authorized By', name: '', title: 'Account Manager' },
  { label: 'Approved By', name: '', title: 'Accounting Head' },
]

export default function DocumentCreation({
  clients,
  projects,
  accounts,
  items,
  launch,
  canGenerate,
  canUseInbox = false,
  draftKey,
  active,
}: {
  clients: Client[]
  projects: Project[]
  accounts?: UserAccount[]
  items: WorkItem[]
  launch?: { taskId: string; flow: 'drf' | 'signoff'; nonce: number }
  canGenerate: boolean
  /** Work Hub: the DRF's task's emails can be read beside the form. */
  canUseInbox?: boolean
  draftKey: string
  active: boolean
}) {
  const docHubReporter = useRef<(error: Error) => void>(() => undefined)
  const [flow, setFlow] = useState<DocumentFlow>(() => {
    try {
      const value = sessionStorage.getItem(`ba-doc-flow:${draftKey}`)
      if (value === 'brd' || value === 'fsd' || value === 'testcase' || value === 'signoff') return value
    } catch {}
    return 'drf'
  })
  const docHub = useDocHubDraft('DRF', error => docHubReporter.current(error), active && flow === 'drf')
  const driveAvailable = useDocumentDrive(active)
  useEffect(() => {
    if (!launch) return
    setFlow(launch.flow)
    const item = items.find(i => i.id === launch.taskId)
    if (launch.flow === 'drf') docHub.setOptions(o => ({ ...o, taskId: launch.taskId, clientId: item?.clientId || '' }))
  }, [launch])
  useEffect(() => {
    try {
      sessionStorage.setItem(`ba-doc-flow:${draftKey}`, flow)
    } catch {}
  }, [flow, draftKey])
  const [corFiles, setCorFiles] = useState<File[]>([])
  const [documentTemplates, setDocumentTemplates] = useState<
    {
      type: 'drf' | 'brd' | 'fsd' | SignoffTemplateKind
      active: boolean
      source: 'custom' | 'built-in' | 'none'
      name: string
      updated_at?: string | null
    }[]
  >([])
  const [corExtractionMode, setCorExtractionMode] = useState<'local' | 'ai'>('local')
  const [aiExtractionStatus, setAiExtractionStatus] = useState<{
    available: boolean
    provider?: string
    model?: string
    error?: string
  }>({ available: false })

  const [settingsRevision, setSettingsRevision] = useState(0)
  useEffect(() => {
    const refresh = () => setSettingsRevision(value => value + 1)
    window.addEventListener('account-document-settings-changed', refresh)
    return () => window.removeEventListener('account-document-settings-changed', refresh)
  }, [])

  useEffect(() => {
    if (!active) return
    let alive = true
    void fetch('/api/account/templates', { credentials: 'same-origin' })
      .then(async response => {
        const payload = (await response.json().catch(() => ({}))) as {
          templates?: {
            type: 'drf' | 'brd' | 'fsd' | SignoffTemplateKind
            active: boolean
            source: 'custom' | 'built-in' | 'none'
            name: string
            updated_at?: string | null
          }[]
        }
        if (response.ok && alive) setDocumentTemplates(Array.isArray(payload.templates) ? payload.templates : [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [draftKey, active, settingsRevision])

  useEffect(() => {
    if (!active) return
    let alive = true
    void fetch('/api/documents/drf/ai-status', { credentials: 'same-origin' })
      .then(async response => {
        const payload = (await response.json().catch(() => ({}))) as {
          available?: boolean
          provider?: string
          model?: string
          error?: string
        }
        if (!alive) return
        setAiExtractionStatus({
          available: Boolean(response.ok && payload.available),
          provider: payload.provider,
          model: payload.model,
          error: payload.error,
        })
        if (!response.ok || !payload.available) setCorExtractionMode('local')
      })
      .catch(() => {
        if (alive) {
          setAiExtractionStatus({ available: false })
          setCorExtractionMode('local')
        }
      })
    return () => {
      alive = false
    }
  }, [draftKey, active, settingsRevision])

  const [businessName, setBusinessName] = useState('')
  const [tradeName, setTradeName] = useState('')
  const [tin, setTin] = useState('')
  const [address, setAddress] = useState('')
  const [branchName, setBranchName] = useState('')
  const [drfFileNameOverride, setDrfFileNameOverride] = useState<string | undefined>()
  const [requestDate, setRequestDate] = useState(todayMmDdYyyy)
  const [goLiveDate, setGoLiveDate] = useState('TBA')
  const [contractNumber, setContractNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [requestFor, setRequestFor] = useState(REQUEST_FOR_OPTIONS[0])
  const [dongle, setDongle] = useState('n/a')
  const [licenseFor, setLicenseFor] = useState('BARTER RPOS 5.1 (CORE)')
  const [requestNote, setRequestNote] = useState('')
  const [posSetup, setPosSetup] = useState('STANDALONE')
  const [posRows, setPosRows] = useState<PosRow[]>([newPosRow()])
  const [signatories, setSignatories] = useState<Signatory[]>(defaultSignatories)
  const [extracting, setExtracting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [documentMessage, setDocumentMessage] = useState('')
  const [documentError, setDocumentError] = useState('')
  const [recentDrfErrors, setRecentDrfErrors] = useState<
    { id: string; stage: string; source: string; message: string; created_at: string }[]
  >([])
  const [drfLogError, setDrfLogError] = useState('')
  const [failedDrfAction, setFailedDrfAction] = useState<'extract' | 'generate'>('extract')
  const operation = useDocumentOperation()
  const corInput = useRef<HTMLInputElement>(null)
  const loadDrfErrors = async () => {
    const response = await fetch('/api/documents/drf/errors', { credentials: 'same-origin' })
    const payload = (await response.json().catch(() => ({}))) as { items?: typeof recentDrfErrors; error?: string }
    if (!response.ok) throw new Error(payload.error || 'Could not load DRF errors.')
    setRecentDrfErrors(payload.items || [])
    setDrfLogError('')
  }
  const showDrfFailure = async (
    stage: 'cor_upload' | 'cor_local' | 'cor_ai' | 'template_render' | 'download' | 'dochub',
    error: unknown,
    context: Record<string, unknown> = {},
  ) => {
    const failure = error as Error & { diagnosticId?: string; loggingUnavailable?: boolean }
    const message = error instanceof Error ? error.message : 'DRF operation failed.'
    let id = failure?.diagnosticId || ''
    let loggingUnavailable = Boolean(failure?.loggingUnavailable)
    if (!id && !loggingUnavailable) {
      try {
        const response = await fetch('/api/documents/drf/errors', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage, message, context }),
        })
        const payload = (await response.json().catch(() => ({}))) as { diagnosticId?: string }
        id = response.ok ? payload.diagnosticId || '' : ''
        loggingUnavailable = !id
      } catch {
        loggingUnavailable = true
      }
    }
    setDocumentError(
      `${message}${id ? ` · Log ID: ${id}` : loggingUnavailable ? ' · Log could not be saved; check the DRF migration and database connection.' : ''}`,
    )
    setDocumentMessage('')
    if (id) void loadDrfErrors().catch(() => undefined)
  }
  docHubReporter.current = error => {
    setFailedDrfAction('generate')
    void showDrfFailure('dochub', error)
  }

  const removeCor = () => {
    operation.cancel()
    docHub.reset()
    setCorFiles([])
    setBusinessName('')
    setTradeName('')
    setTin('')
    setAddress('')
    setExtracting(false)
    setGenerating(false)
    setDocumentMessage('')
    setDocumentError('')
    if (corInput.current) corInput.current.value = ''
  }
  const resetDrf = () => {
    removeCor()
    setBranchName('')
    setDrfFileNameOverride(undefined)
    setRequestDate(todayMmDdYyyy())
    setGoLiveDate('TBA')
    setContractNumber('')
    setNotes('')
    setRequestFor(REQUEST_FOR_OPTIONS[0])
    setDongle('n/a')
    setLicenseFor('BARTER RPOS 5.1 (CORE)')
    setRequestNote('')
    setPosSetup('STANDALONE')
    setPosRows([newPosRow()])
    setSignatories(defaultSignatories.map(signatory => ({ ...signatory })))
    setCorExtractionMode('local')
  }

  const selectedTitle = useMemo(
    () =>
      flow === 'drf'
        ? 'DRF Creation'
        : flow === 'brd'
          ? 'BRD Creation'
          : flow === 'fsd'
            ? 'FSD Creation'
            : flow === 'testcase'
              ? 'Test Case Creation'
              : 'Sign Off Document',
    [flow],
  )
  const drfTemplate = documentTemplates.find(template => template.type === 'drf')
  const brdTemplate = documentTemplates.find(template => template.type === 'brd')
  const fsdTemplate = documentTemplates.find(template => template.type === 'fsd')
  // One built-in or custom Word template per Sign Off form (Settings → Templates).
  const signoffTemplatesReady = Object.fromEntries(
    SIGNOFF_FORM_TYPES.map(type => [
      type,
      Boolean(documentTemplates.find(template => template.type === SIGNOFF_TEMPLATE_KIND[type])?.active),
    ]),
  ) as Record<SignoffFormType, boolean>
  const corFile = corFiles[0]
  const drfClientName = clients.find(client => client.id === docHub.options.clientId)?.name || businessName || tradeName
  const suggestedDrfFileName = suggestedDocumentStem('DRF', drfClientName, branchName)
  const drfFileName = drfFileNameOverride ?? suggestedDrfFileName

  const handleFiles =
    (setter: (files: File[]) => void, multiple = false, maxBytes?: number) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || [])
      const selected = multiple ? files : files.slice(0, 1)
      if (maxBytes && selected.some(file => file.size > maxBytes)) {
        void showDrfFailure(
          'cor_upload',
          new Error(`File is too large. Maximum allowed size is ${formatBytes(maxBytes)}.`),
          { fileType: selected[0]?.type, fileBytes: selected[0]?.size },
        )
        event.target.value = ''
        return
      }
      setDocumentError('')
      setDocumentMessage('')
      setter(selected)
      event.target.value = ''
    }

  // A COR already saved in Google Drive takes the same path as one chosen from this computer.
  const pickCorFromDrive = (file: File) => {
    if (file.size > MAX_COR_BYTES) {
      void showDrfFailure(
        'cor_upload',
        new Error(`File is too large. Maximum allowed size is ${formatBytes(MAX_COR_BYTES)}.`),
        { fileType: file.type, fileBytes: file.size },
      )
      return
    }
    setDocumentError('')
    setDocumentMessage('')
    setCorFiles([file])
  }

  // Clients and teammates whose email can be suggested for a signatory name.
  const people = useMemo(() => knownPeople({ clients, accounts }), [clients, accounts])
  const updateSignatory = (index: number, patch: Partial<Signatory>) => {
    setSignatories(current =>
      current.map((signatory, currentIndex) => (currentIndex === index ? { ...signatory, ...patch } : signatory)),
    )
  }

  const updatePosRow = (id: string, patch: Partial<PosRow>) => {
    setPosRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)))
  }

  const extractCor = async () => {
    if (!corFile || extracting || generating || docHub.busy || !canGenerate) return
    const job = operation.begin()
    const progress = (message: string) => {
      if (job.isCurrent()) setDocumentMessage(message)
    }
    setExtracting(true)
    setDocumentError('')
    setDocumentMessage(
      corExtractionMode === 'ai'
        ? 'Reading the COR locally before AI extraction…'
        : 'Preparing private local COR extraction…',
    )
    let stage: 'cor_local' | 'cor_ai' = 'cor_local'
    try {
      let extraction: { businessName: string; tradeName: string; tin: string; address: string; notes: string }
      if (corExtractionMode === 'ai') {
        if (!aiExtractionStatus.available)
          throw new Error(
            'AI extraction is unavailable. Configure and enable the Document Agent in Account Settings, or use Local Extractor.',
          )
        const localText = await extractCorTextLocally(corFile, progress)
        if (!job.isCurrent()) return
        setDocumentMessage(
          `Local text is ready. Asking ${aiExtractionStatus.provider || 'the Document Agent'} to map the COR fields…`,
        )
        stage = 'cor_ai'
        extraction = await postJson<typeof extraction>(
          '/api/documents/drf/extract-cor-ai',
          {
            text: localText.text,
            sourceMethod: localText.method,
            fileName: corFile.name,
          },
          job.signal,
        )
      } else {
        extraction = await extractCorLocally(corFile, progress)
      }
      if (!job.isCurrent()) return
      setBusinessName(extraction.businessName || '')
      setTradeName(extraction.tradeName || '')
      setTin(extraction.tin || '')
      setAddress(extraction.address || '')
      setDocumentMessage(`COR extraction completed. ${extraction.notes}`)
    } catch (error) {
      if (!job.isCurrent()) return
      setFailedDrfAction('extract')
      await showDrfFailure(stage, error, {
        fileType: corFile.type,
        fileBytes: corFile.size,
        extractionMode: corExtractionMode,
      })
    } finally {
      if (job.isCurrent()) setExtracting(false)
    }
  }

  const generateDrf = async () => {
    if (!drfTemplate?.active || !canGenerate || extracting || generating || docHub.busy) return
    try {
      docHub.validate(signatories)
    } catch (e) {
      setFailedDrfAction('generate')
      void showDrfFailure('dochub', e)
      return
    }
    const job = operation.begin()
    setGenerating(true)
    setDocumentError('')
    setDocumentMessage('Placing DRF values into the account’s saved Excel template…')
    let stage: 'template_render' | 'download' | 'dochub' = 'template_render'
    try {
      const signatoryValues = Object.fromEntries(
        signatories.flatMap((signatory, index) => {
          const number = index + 1
          return [
            [`signatory_${number}_label`, signatory.label.trim()],
            [`signatory_${number}_name`, signatory.name.trim()],
            [`signatory_${number}_title`, signatory.title.trim()],
          ]
        }),
      )
      const values = {
        business_name: businessName.trim(),
        branch_name: branchName.trim(),
        trade_name: tradeName.trim(),
        tin: tin.trim(),
        address: address.trim(),
        request_date: requestDate,
        go_live_date: goLiveDate.trim(),
        contract_number: contractNumber.trim(),
        notes: notes.trim(),
        request_for: requestFor,
        dongle: dongle.trim(),
        license_for: licenseFor.trim(),
        request_note: requestNote.trim(),
        pos_setup: posSetup.trim(),
        ...signatoryValues,
      }
      const result = await postJson<{
        fileData: string
        fileName: string
        mimeType: string
        matchedFields?: string[]
        posRowsWritten?: number
      }>(
        '/api/documents/drf/render-template',
        {
          values,
          fileName: documentOutputName(drfFileName, 'xlsx', suggestedDrfFileName),
          posRows: posRows.map(({ computerName, serialNo, brand, model }) => ({
            computerName,
            serialNo,
            brand,
            model,
          })),
        },
        job.signal,
      )
      if (!job.isCurrent()) return
      stage = 'download'
      downloadBase64File(result.fileData, result.mimeType, result.fileName)
      stage = 'dochub'
      await docHub.prepare(result, signatories)
      if (!job.isCurrent()) return
      const matched = result.matchedFields?.length ? ` ${result.matchedFields.length} DRF fields were populated.` : ''
      const rows = result.posRowsWritten
        ? ` ${result.posRowsWritten} POS row${result.posRowsWritten === 1 ? '' : 's'} added.`
        : ''
      setDocumentMessage(`DRF generated successfully.${matched}${rows}`)
    } catch (error) {
      if (!job.isCurrent()) return
      setFailedDrfAction('generate')
      await showDrfFailure(stage, error, { templateType: 'xlsx' })
    } finally {
      if (job.isCurrent()) setGenerating(false)
    }
  }

  return (
    <section className="page-stack document-creation-page">
      <div className="callout document-module-callout">
        <FileText size={23} />
        <div>
          <strong>Document Creation</strong>
          <p>
            Create BA delivery documents from source files. BRD Creation can turn incomplete requirements into an
            editable business draft, then hand the structured result directly to FSD Creation.
          </p>
        </div>
      </div>

      <div className="document-flow-grid">
        <button
          type="button"
          className={`document-flow-card${flow === 'drf' ? ' active' : ''}`}
          onClick={() => setFlow('drf')}
        >
          <div className="document-flow-icon">
            <BriefcaseBusiness size={22} />
          </div>
          <div>
            <strong>DRF Creation</strong>
            <span>Extract COR details and populate the Excel DRF form.</span>
          </div>
          <small>COR + XLSX template</small>
        </button>
        <button
          type="button"
          className={`document-flow-card${flow === 'brd' ? ' active' : ''}`}
          onClick={() => setFlow('brd')}
        >
          <div className="document-flow-icon">
            <FileCog size={22} />
          </div>
          <div>
            <strong>BRD Creation</strong>
            <span>Draft a structured BRD from incomplete notes, documents, screenshots, or pasted requirements.</span>
          </div>
          <small>AI + DOCX + FSD handoff</small>
        </button>
        <button
          type="button"
          className={`document-flow-card${flow === 'fsd' ? ' active' : ''}`}
          onClick={() => setFlow('fsd')}
        >
          <div className="document-flow-icon">
            <Clipboard size={22} />
          </div>
          <div>
            <strong>FSD Creation</strong>
            <span>Advanced source mapping and scope controls with your configured AI.</span>
          </div>
          <small>BRD / Requirements</small>
        </button>
        <button
          type="button"
          className={`document-flow-card${flow === 'testcase' ? ' active' : ''}`}
          onClick={() => setFlow('testcase')}
        >
          <div className="document-flow-icon">
            <ClipboardCheck size={22} />
          </div>
          <div>
            <strong>Test Case Creation</strong>
            <span>AI coverage mapping, reusable QA skills, editable test cases, and XLSX export.</span>
          </div>
          <small>AI + Skills + XLSX</small>
        </button>
        <button
          type="button"
          className={`document-flow-card${flow === 'signoff' ? ' active' : ''}`}
          onClick={() => setFlow('signoff')}
        >
          <div className="document-flow-icon">
            <CheckCircle2 size={22} />
          </div>
          <div>
            <strong>Sign Off Document</strong>
            <span>
              Production Deployment, Go Live, UAT, UAT Deployment and Training forms with editable details, tables and
              attachments.
            </span>
          </div>
          <small>Attachments supported</small>
        </button>
      </div>

      <div className="panel document-workspace">
        <div className="panel-heading document-heading">
          <div>
            <h2>{selectedTitle}</h2>
            <p>
              {flow === 'drf'
                ? 'Upload a COR and use the account’s saved standard Excel DRF template. Extracted values and DRF-specific details remain editable before download.'
                : flow === 'brd'
                  ? 'Add whatever business information is available. The Document Agent creates a best-effort BRD draft, flags inferred content, and keeps every section editable.'
                  : flow === 'fsd'
                    ? 'Add a BRD or other requirements, choose a preset, then review and export using the iRipple FSD template.'
                    : flow === 'testcase'
                      ? 'Upload requirement sources, select reusable QA skills, review the AI coverage map, then generate editable test cases and export to Excel.'
                      : 'Choose a form, edit its details and sections, then add signatories and supporting attachments.'}
            </p>
          </div>
          <span className="document-stage-pill">
            {flow === 'drf'
              ? drfTemplate?.active
                ? 'DRF template ready'
                : 'DRF template required'
              : flow === 'brd'
                ? brdTemplate?.active
                  ? 'BRD template ready'
                  : 'BRD template required'
                : flow === 'signoff'
                  ? Object.values(signoffTemplatesReady).every(Boolean)
                    ? 'All Sign Off templates ready'
                    : 'Check the selected form’s template status'
                  : flow === 'testcase'
                    ? 'AI test suite workflow'
                    : fsdTemplate?.active
                      ? 'FSD template ready'
                      : 'FSD template required'}
          </span>
        </div>

        {flow === 'drf' && (
          <div className="document-drf-stack">
            <DocumentReset label="DRF" onReset={resetDrf} disabled={!canGenerate} />
            <div className="document-workspace-grid document-source-grid">
              <div className="document-upload-panel">
                <div className="document-section-title">
                  <ScanLine size={18} />
                  <div>
                    <strong>1. Company COR</strong>
                    <span>
                      Local Extractor is the default · optional tenant AI enhancement · PDF, JPEG, PNG, WEBP, TIFF, BMP,
                      DOCX · maximum 12 MB
                    </span>
                  </div>
                </div>
                <div className="document-extraction-mode">
                  <div className="document-extraction-mode-copy">
                    <strong>COR Extraction Method</strong>
                    <span>
                      {corExtractionMode === 'local'
                        ? 'Runs entirely in your browser with no AI API usage.'
                        : `Uses local OCR/text reading first, then ${aiExtractionStatus.provider || 'your Document Agent'} to map and refine the COR fields.`}
                    </span>
                  </div>
                  <label className={`document-ai-toggle ${!aiExtractionStatus.available ? 'disabled' : ''}`}>
                    <span className="document-ai-toggle-label">Local</span>
                    <input
                      type="checkbox"
                      checked={corExtractionMode === 'ai'}
                      disabled={!aiExtractionStatus.available || extracting}
                      onChange={event => setCorExtractionMode(event.target.checked ? 'ai' : 'local')}
                      aria-label="Use AI Enhanced COR extraction"
                    />
                    <span className="document-toggle-track">
                      <span />
                    </span>
                    <span className="document-ai-toggle-label">AI Enhanced</span>
                  </label>
                  {!aiExtractionStatus.available && (
                    <small>
                      AI Enhanced is unavailable. Configure and enable the Document Agent in Account Settings to use it.
                    </small>
                  )}
                  {aiExtractionStatus.available && corExtractionMode === 'ai' && (
                    <small>
                      Only locally extracted COR text is sent to{' '}
                      {aiExtractionStatus.provider || 'the configured Document Agent'}; the COR file itself stays in
                      your browser. AI usage may incur provider charges.
                    </small>
                  )}
                </div>
                <label className="document-dropzone document-dropzone-compact">
                  <input
                    ref={corInput}
                    type="file"
                    accept={COR_ACCEPT}
                    disabled={!canGenerate || extracting || generating || docHub.busy}
                    onChange={handleFiles(setCorFiles, false, MAX_COR_BYTES)}
                  />
                  <Plus size={27} />
                  <strong>{corFiles.length ? 'Replace COR file' : 'Choose a COR file'}</strong>
                  <span>
                    {corExtractionMode === 'local'
                      ? 'The COR stays in your browser and no AI API key is used.'
                      : 'The COR file stays in your browser; only locally extracted text is sent to the Document Agent.'}
                  </span>
                </label>
                {driveAvailable && (
                  <DriveFilePicker
                    items={items}
                    clients={clients}
                    projects={projects}
                    accept={COR_ACCEPT}
                    maxBytes={MAX_COR_BYTES}
                    disabled={!canGenerate || extracting || generating || docHub.busy}
                    onPick={pickCorFromDrive}
                    onError={message => setDocumentError(message)}
                  />
                )}
                <FileSummary
                  files={corFiles}
                  onRemove={removeCor}
                  disabled={!canGenerate || generating || docHub.busy}
                />
                <button
                  type="button"
                  className="secondary document-wide-button"
                  disabled={!canGenerate || !corFile || extracting || generating || docHub.busy}
                  onClick={extractCor}
                >
                  <ScanLine size={16} />{' '}
                  {extracting
                    ? 'Extracting…'
                    : corExtractionMode === 'ai'
                      ? 'Extract COR details with AI'
                      : 'Extract COR details locally'}
                </button>
              </div>

              {canUseInbox ? (
                <LinkedEmails
                  taskId={docHub.options.taskId}
                  clientId={docHub.options.clientId}
                  items={items}
                  clients={clients}
                  projects={projects}
                  disabled={generating || docHub.busy}
                  active={active}
                  onTaskChange={id =>
                    docHub.setOptions(o => ({
                      ...o,
                      taskId: id,
                      clientId: items.find(item => item.id === id)?.clientId || o.clientId,
                    }))
                  }
                  onClientChange={id =>
                    docHub.setOptions(o => (o.clientId === id ? o : { ...o, clientId: id, taskId: '' }))
                  }
                >
                  {!drfTemplate?.active && (
                    <div className="document-standard-template empty">
                      <FileCog size={18} />
                      <div>
                        <strong>No DRF template configured</strong>
                        <span>
                          An account Administrator must add the DRF template under Settings → Templates before a DRF can
                          be generated.
                        </span>
                      </div>
                    </div>
                  )}
                </LinkedEmails>
              ) : (
                <div className="document-upload-panel">
                  <div className="document-section-title">
                    <FileCog size={18} />
                    <div>
                      <strong>2. Standard DRF Excel Template</strong>
                      <span>Managed centrally in Settings → Templates</span>
                    </div>
                  </div>
                  {drfTemplate?.active ? (
                    <div className="document-standard-template">
                      <div className="document-standard-template-status">
                        <CheckCircle2 size={18} />
                        <div>
                          <strong>Standard template active</strong>
                          <span>{drfTemplate.name}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="document-standard-template empty">
                      <FileCog size={18} />
                      <div>
                        <strong>No DRF template configured</strong>
                        <span>
                          An account Administrator must add the DRF template under Settings → Templates before a DRF can
                          be generated.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="document-drf-config-grid">
              <div className="document-extraction-panel">
                <div className="document-section-title">
                  <Clipboard size={18} />
                  <div>
                    <strong>3. COR extracted details</strong>
                    <span>These four values come from the COR and can be corrected before generation.</span>
                  </div>
                </div>
                <div className="document-field-grid">
                  <label>
                    Business / Registered Name
                    <input
                      value={businessName}
                      onChange={event => setBusinessName(event.target.value)}
                      placeholder="Name of Taxpayer / registered name"
                    />
                  </label>
                  <label>
                    Trade / Business Name
                    <input
                      value={tradeName}
                      onChange={event => setTradeName(event.target.value)}
                      placeholder="Trade Name from COR"
                    />
                  </label>
                  <label>
                    TIN
                    <input
                      value={tin}
                      onChange={event => setTin(event.target.value)}
                      placeholder="TIN / branch code exactly as shown"
                    />
                  </label>
                  <label className="document-field-wide">
                    Registered Address
                    <textarea
                      value={address}
                      onChange={event => setAddress(event.target.value)}
                      placeholder="Registered business address"
                      rows={3}
                    />
                  </label>
                </div>

                <div className="document-subsection">
                  <div className="document-subsection-heading">
                    <div>
                      <strong>DRF details</strong>
                      <span>Fields from the Excel form that are not extracted from the COR.</span>
                    </div>
                  </div>
                  <div className="document-field-grid document-drf-fields">
                    <label>
                      Branch Name
                      <input
                        value={branchName}
                        onChange={event => setBranchName(event.target.value)}
                        placeholder="e.g. iRipple - Ortigas Pasig"
                      />
                    </label>
                    <label className="document-field-wide">
                      Filename (extension added automatically)
                      <input
                        aria-label="DRF filename"
                        value={drfFileName}
                        maxLength={150}
                        onChange={event => setDrfFileNameOverride(event.target.value)}
                        onBlur={() => {
                          if (!drfFileNameOverride?.trim()) setDrfFileNameOverride(undefined)
                        }}
                      />
                      <small>
                        Download and DocHub:{' '}
                        {documentOutputName(
                          drfFileName,
                          drfTemplate?.name.split('.').pop() || 'xlsx',
                          suggestedDrfFileName,
                        )}
                      </small>
                    </label>
                    <label>
                      Request Date
                      <input
                        value={requestDate}
                        readOnly
                        className="document-readonly-input"
                        title="Automatically set to the date this DRF is created"
                      />
                    </label>
                    <label>
                      GO-LIVE Date
                      <input
                        value={goLiveDate}
                        onChange={event => setGoLiveDate(event.target.value)}
                        placeholder="MM/DD/YYYY or TBA"
                      />
                    </label>
                    <label>
                      Contract Number (SLSS-DRF)
                      <input
                        value={contractNumber}
                        onChange={event => setContractNumber(event.target.value)}
                        placeholder="Contract / SLSS-DRF reference"
                      />
                    </label>
                    <label>
                      Request For
                      <select value={requestFor} onChange={event => setRequestFor(event.target.value)}>
                        {REQUEST_FOR_OPTIONS.map(option => (
                          <option value={option} key={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Dongle
                      <input
                        value={dongle}
                        onChange={event => setDongle(event.target.value)}
                        placeholder="n/a, NEW, REPLACEMENT, DONGLELESS"
                      />
                    </label>
                    <label>
                      License For
                      <input
                        value={licenseFor}
                        onChange={event => setLicenseFor(event.target.value)}
                        placeholder="BARTER RPOS 5.1 (CORE)"
                      />
                    </label>
                    <label>
                      POS Setup
                      <input
                        value={posSetup}
                        onChange={event => setPosSetup(event.target.value)}
                        placeholder="STANDALONE"
                      />
                    </label>
                    <label className="document-field-wide">
                      Notes / Instructions
                      <textarea
                        value={notes}
                        onChange={event => setNotes(event.target.value)}
                        placeholder="Optional notes/instructions"
                        rows={2}
                      />
                    </label>
                    <label className="document-field-wide">
                      Request Note
                      <input
                        value={requestNote}
                        onChange={event => setRequestNote(event.target.value)}
                        placeholder="Optional note shown on the DRF"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <div className="document-extraction-panel">
                <div className="document-section-title">
                  <UserRound size={18} />
                  <div>
                    <strong>4. Signatories</strong>
                    <span>These map to the three main signatory blocks at the bottom of the Excel DRF.</span>
                  </div>
                </div>
                <div className="document-signatory-list">
                  {signatories.map((signatory, index) => (
                    <div className="document-signatory-card" key={index}>
                      <div className="document-signatory-number">{index + 1}</div>
                      <div className="document-signatory-fields">
                        <label>
                          Label
                          <input
                            value={signatory.label}
                            onChange={event => updateSignatory(index, { label: event.target.value })}
                            placeholder="Prepared By"
                          />
                        </label>
                        <PersonNameInput
                          label="Name"
                          value={signatory.name}
                          email={signatory.email || ''}
                          onName={name => updateSignatory(index, { name })}
                          onEmail={email => updateSignatory(index, { email })}
                          local={people}
                          placeholder="Signatory name"
                        />
                        <label>
                          Email (DocHub only)
                          <input
                            type="email"
                            value={signatory.email || ''}
                            onChange={event => updateSignatory(index, { email: event.target.value })}
                            placeholder="signer@company.com"
                          />
                        </label>
                        <label>
                          Title / Position
                          <input
                            value={signatory.title}
                            onChange={event => updateSignatory(index, { title: event.target.value })}
                            placeholder="Account Manager"
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="document-template-guide">
                  <strong>Mapped Excel areas</strong>
                  <span>
                    Company details → rows 3–8 · request details → rows 3–13 · POS rows → rows 16–32 · signatories →
                    rows 39–41. iRipple-only columns for POS MIN, Permit Number, and License Serial Key are preserved
                    and left untouched.
                  </span>
                </div>
              </div>
            </div>

            <div className="document-pos-panel">
              <div className="document-subsection-heading">
                <div>
                  <strong>5. POS / Computer Rows</strong>
                  <span>
                    Add one row per machine. The current DRF template provides {MAX_POS_ROWS} rows (Excel rows 16–32).
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary compact"
                  disabled={posRows.length >= MAX_POS_ROWS}
                  onClick={() => setPosRows(current => [...current, newPosRow()])}
                >
                  <Plus size={14} /> Add row
                </button>
              </div>
              <div className="document-pos-table-wrap">
                <table className="document-pos-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Computer Name</th>
                      <th>POS Machine Serial No.</th>
                      <th>Machine Brand</th>
                      <th>Machine Model</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {posRows.map((row, index) => (
                      <tr key={row.id}>
                        <td>{index + 1}</td>
                        <td>
                          <input
                            maxLength={16}
                            value={row.computerName}
                            onChange={event => updatePosRow(row.id, { computerName: event.target.value.toUpperCase() })}
                            placeholder="PC01"
                            title="Maximum 16 characters"
                          />
                        </td>
                        <td>
                          <input
                            value={row.serialNo}
                            onChange={event => updatePosRow(row.id, { serialNo: event.target.value })}
                            placeholder="Serial number"
                          />
                        </td>
                        <td>
                          <input
                            value={row.brand}
                            onChange={event => updatePosRow(row.id, { brand: event.target.value })}
                            placeholder="Brand"
                          />
                        </td>
                        <td>
                          <input
                            value={row.model}
                            onChange={event => updatePosRow(row.id, { model: event.target.value })}
                            placeholder="Model"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="icon-button danger"
                            title="Remove row"
                            disabled={posRows.length === 1}
                            onClick={() => setPosRows(current => current.filter(candidate => candidate.id !== row.id))}
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <DocumentProcessingPanel
              state={
                documentError ? 'error' : extracting || generating ? 'working' : documentMessage ? 'success' : 'idle'
              }
              title={
                documentError
                  ? 'Document processing failed'
                  : generating
                    ? 'Generating your DRF…'
                    : extracting
                      ? 'Reading your COR…'
                      : 'Document is ready'
              }
              detail={documentError || documentMessage}
              stages={
                extracting
                  ? [
                      'Uploading document',
                      'Reading and extracting content',
                      'Mapping COR fields',
                      'Finalizing extracted values',
                    ]
                  : ['Preparing template', 'Mapping reviewed information', 'Generating document', 'Starting download']
              }
              activeStage={generating ? 2 : extracting ? (documentMessage.toLowerCase().includes('asking') ? 2 : 1) : 3}
              onRetry={
                documentError ? () => void (failedDrfAction === 'extract' ? extractCor() : generateDrf()) : undefined
              }
            />
            <details
              className="document-extraction-panel"
              onToggle={event => {
                if (event.currentTarget.open) void loadDrfErrors().catch(error => setDrfLogError(error.message))
              }}
            >
              <summary>Recent DRF errors (saved to database)</summary>
              <p>Only your DRF errors appear here. Uploaded files, COR text, and entered form values are not logged.</p>
              <button
                type="button"
                className="secondary compact"
                onClick={() => void loadDrfErrors().catch(error => setDrfLogError(error.message))}
              >
                Refresh errors
              </button>
              {drfLogError && <p role="alert">{drfLogError}</p>}
              {!drfLogError && !recentDrfErrors.length && <p>No DRF errors found.</p>}
              {recentDrfErrors.length > 0 && (
                <ul>
                  {recentDrfErrors.map(entry => (
                    <li key={entry.id}>
                      <strong>
                        {entry.stage.replace(/_/g, ' ')} · {new Date(entry.created_at).toLocaleString()}
                      </strong>
                      <div>{entry.message}</div>
                      <small>Log ID: {entry.id}</small>
                    </li>
                  ))}
                </ul>
              )}
            </details>

            <DocHubOptions
              key={docHub.resetVersion}
              draft={docHub}
              clients={clients}
              projects={projects}
              items={items}
              disabled={!canGenerate || generating || extracting}
            />
            <DocHubResult draft={docHub} />
            <div className="document-generate-bar">
              <div>
                <strong>6. Generate DRF</strong>
                <span>
                  The reviewed values are written into the saved standard Excel template and downloaded as a new .xlsx
                  file.
                </span>
              </div>
              <button
                type="button"
                className="primary"
                disabled={!canGenerate || !drfTemplate?.active || extracting || generating || docHub.busy}
                onClick={generateDrf}
              >
                <Download size={16} />{' '}
                {generating || docHub.busy
                  ? 'Processing…'
                  : docHub.enabled
                    ? 'Generate & Prepare in DocHub'
                    : 'Generate & Download DRF'}
              </button>
            </div>
          </div>
        )}

        <div className="fsd-retained" hidden={flow !== 'brd'}>
          <BrdCreation
            projects={projects}
            canGenerate={canGenerate}
            templateReady={Boolean(brdTemplate?.active)}
            draftKey={draftKey}
            active={active && flow === 'brd'}
            onUseInFsd={handoff => {
              try {
                sessionStorage.setItem(`ba-brd-handoff:${draftKey}`, JSON.stringify(handoff))
                setFlow('fsd')
              } catch {
                window.alert(
                  'Browser session storage is unavailable. Download the BRD and upload it to FSD Creation instead.',
                )
              }
            }}
          />
          <SaveToDriveBar flow="brd" label="BRD" items={items} clients={clients} projects={projects} />
        </div>

        <div className="fsd-retained" hidden={flow !== 'fsd'}>
          <FsdCreation
            clients={clients}
            projects={projects}
            canGenerate={canGenerate}
            templateReady={Boolean(fsdTemplate?.active)}
            draftKey={draftKey}
            active={active && flow === 'fsd'}
          />
          <SaveToDriveBar flow="fsd" label="FSD" items={items} clients={clients} projects={projects} />
        </div>

        <div className="testcase-retained" hidden={flow !== 'testcase'}>
          <TestCaseCreation canGenerate={canGenerate} draftKey={draftKey} active={active && flow === 'testcase'} />
          <SaveToDriveBar flow="testcase" label="test case suite" items={items} clients={clients} projects={projects} />
        </div>

        <div hidden={flow !== 'signoff'}>
          <SignOffCreation
            active={active && flow === 'signoff'}
            clients={clients}
            projects={projects}
            accounts={accounts}
            items={items}
            launch={launch}
            canGenerate={canGenerate}
            templateReady={signoffTemplatesReady}
          />
        </div>
      </div>
      <DocHubHistory active={active} clients={clients} projects={projects} items={items} />
    </section>
  )
}
