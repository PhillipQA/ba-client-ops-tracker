import { useMemo, useState } from 'react'
import { extractCorLocally } from './corOcr'
import {
  BriefcaseBusiness,
  CheckCircle2,
  Clipboard,
  Download,
  FileCog,
  FileText,
  Inbox,
  Plus,
  ScanLine,
  Trash2,
  UserRound,
} from 'lucide-react'

type DocumentFlow = 'drf' | 'fsd' | 'signoff'

type Signatory = {
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
const TEMPLATE_ACCEPT = '.xlsx'
const BRD_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt'
const ATTACHMENT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.txt,.zip'
const MAX_COR_BYTES = 12 * 1024 * 1024
const MAX_TEMPLATE_BYTES = 12 * 1024 * 1024
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

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(payload.error || 'Document request failed.')
  return payload
}

function FileSummary({ files }: { files: File[] }) {
  if (!files.length) return null
  return (
    <div className="document-file-list">
      {files.map((file, index) => (
        <div className="document-file-row" key={`${file.name}-${file.size}-${index}`}>
          <FileText size={16} />
          <div><strong>{file.name}</strong><span>{formatBytes(file.size)} · {file.type || 'Unknown type'}</span></div>
          <CheckCircle2 size={16} className="document-file-check" />
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

export default function DocumentCreation() {
  const [flow, setFlow] = useState<DocumentFlow>('drf')
  const [corFiles, setCorFiles] = useState<File[]>([])
  const [templateFiles, setTemplateFiles] = useState<File[]>([])
  const [brdFiles, setBrdFiles] = useState<File[]>([])
  const [signoffFiles, setSignoffFiles] = useState<File[]>([])
  const [businessName, setBusinessName] = useState('')
  const [tradeName, setTradeName] = useState('')
  const [tin, setTin] = useState('')
  const [address, setAddress] = useState('')
  const [branchName, setBranchName] = useState('')
  const [requestDate] = useState(todayMmDdYyyy)
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

  const selectedTitle = useMemo(() => flow === 'drf' ? 'DRF Creation' : flow === 'fsd' ? 'FSD Creation' : 'Sign Off Form', [flow])
  const templateFile = templateFiles[0]
  const corFile = corFiles[0]

  const handleFiles = (setter: (files: File[]) => void, multiple = false, maxBytes?: number) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    const selected = multiple ? files : files.slice(0, 1)
    if (maxBytes && selected.some((file) => file.size > maxBytes)) {
      setDocumentError(`File is too large. Maximum allowed size is ${formatBytes(maxBytes)}.`)
      event.target.value = ''
      return
    }
    setDocumentError('')
    setDocumentMessage('')
    setter(selected)
  }

  const updateSignatory = (index: number, patch: Partial<Signatory>) => {
    setSignatories((current) => current.map((signatory, currentIndex) => currentIndex === index ? { ...signatory, ...patch } : signatory))
  }

  const updatePosRow = (id: string, patch: Partial<PosRow>) => {
    setPosRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row))
  }

  const extractCor = async () => {
    if (!corFile) return
    setExtracting(true)
    setDocumentError('')
    setDocumentMessage('Preparing private local COR extraction…')
    try {
      const extraction = await extractCorLocally(corFile, (message) => setDocumentMessage(message))
      setBusinessName(extraction.businessName || '')
      setTradeName(extraction.tradeName || '')
      setTin(extraction.tin || '')
      setAddress(extraction.address || '')
      setDocumentMessage(`COR extraction completed. ${extraction.notes}`)
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : 'COR extraction failed.')
      setDocumentMessage('')
    } finally {
      setExtracting(false)
    }
  }

  const generateDrf = async () => {
    if (!templateFile) return
    setGenerating(true)
    setDocumentError('')
    setDocumentMessage('Placing DRF values into the uploaded Excel template…')
    try {
      const signatoryValues = Object.fromEntries(signatories.flatMap((signatory, index) => {
        const number = index + 1
        return [
          [`signatory_${number}_label`, signatory.label.trim()],
          [`signatory_${number}_name`, signatory.name.trim()],
          [`signatory_${number}_title`, signatory.title.trim()],
        ]
      }))
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
      const templateData = await fileToBase64(templateFile)
      const result = await postJson<{ fileData: string; fileName: string; mimeType: string; matchedFields?: string[]; posRowsWritten?: number }>('/api/documents/drf/render-template', {
        templateName: templateFile.name,
        mimeType: templateFile.type,
        templateData,
        values,
        posRows: posRows.map(({ computerName, serialNo, brand, model }) => ({ computerName, serialNo, brand, model })),
      })
      downloadBase64File(result.fileData, result.mimeType, result.fileName)
      const matched = result.matchedFields?.length ? ` ${result.matchedFields.length} DRF fields were populated.` : ''
      const rows = result.posRowsWritten ? ` ${result.posRowsWritten} POS row${result.posRowsWritten === 1 ? '' : 's'} added.` : ''
      setDocumentMessage(`DRF generated successfully.${matched}${rows}`)
    } catch (error) {
      setDocumentError(error instanceof Error ? error.message : 'DRF generation failed.')
      setDocumentMessage('')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <section className="page-stack document-creation-page">
      <div className="callout document-module-callout">
        <FileText size={23} />
        <div>
          <strong>Document Creation</strong>
          <p>Create BA delivery documents from source files. DRF Creation reads company COR details and writes the reviewed values directly into the approved Excel DRF template.</p>
        </div>
      </div>

      <div className="document-flow-grid">
        <button type="button" className={`document-flow-card${flow === 'drf' ? ' active' : ''}`} onClick={() => setFlow('drf')}>
          <div className="document-flow-icon"><BriefcaseBusiness size={22} /></div>
          <div><strong>DRF Creation</strong><span>Extract COR details and populate the Excel DRF form.</span></div>
          <small>COR + XLSX template</small>
        </button>
        <button type="button" className={`document-flow-card${flow === 'fsd' ? ' active' : ''}`} onClick={() => setFlow('fsd')}>
          <div className="document-flow-icon"><Clipboard size={22} /></div>
          <div><strong>FSD Creation</strong><span>Use an approved BRD as the source for an FSD.</span></div>
          <small>BRD required</small>
        </button>
        <button type="button" className={`document-flow-card${flow === 'signoff' ? ' active' : ''}`} onClick={() => setFlow('signoff')}>
          <div className="document-flow-icon"><CheckCircle2 size={22} /></div>
          <div><strong>Sign Off Form</strong><span>Prepare a sign-off package with supporting attachments.</span></div>
          <small>Attachments supported</small>
        </button>
      </div>

      <div className="panel document-workspace">
        <div className="panel-heading document-heading">
          <div><h2>{selectedTitle}</h2><p>{flow === 'drf' ? 'Upload a COR and the approved Excel DRF template. Extracted values and DRF-specific details remain editable before download.' : flow === 'fsd' ? 'Upload the BRD that will serve as the required source document for the FSD.' : 'Add the documents that will be included with or referenced by the sign-off form.'}</p></div>
          <span className="document-stage-pill">{flow === 'drf' ? (templateFile ? 'Excel template ready' : 'Excel template required') : 'Template pending'}</span>
        </div>

        {flow === 'drf' && (
          <div className="document-drf-stack">
            <div className="document-workspace-grid document-source-grid">
              <div className="document-upload-panel">
                <div className="document-section-title"><ScanLine size={18} /><div><strong>1. Company COR</strong><span>Private local extraction · PDF, JPEG, PNG, WEBP, TIFF, BMP, DOCX · maximum 12 MB</span></div></div>
                <label className="document-dropzone document-dropzone-compact">
                  <input type="file" accept={COR_ACCEPT} onChange={handleFiles(setCorFiles, false, MAX_COR_BYTES)} />
                  <Plus size={27} />
                  <strong>{corFiles.length ? 'Replace COR file' : 'Choose a COR file'}</strong>
                  <span>The COR stays in your browser. No OpenAI API key is required and the COR file is not uploaded to the server for extraction.</span>
                </label>
                <FileSummary files={corFiles} />
                <button type="button" className="secondary document-wide-button" disabled={!corFile || extracting} onClick={extractCor}><ScanLine size={16} /> {extracting ? 'Extracting…' : 'Extract COR details locally'}</button>
              </div>

              <div className="document-upload-panel">
                <div className="document-section-title"><FileCog size={18} /><div><strong>2. DRF Excel Template</strong><span>Approved iRipple .xlsx template · maximum 12 MB</span></div></div>
                <label className="document-dropzone document-dropzone-compact">
                  <input type="file" accept={TEMPLATE_ACCEPT} onChange={handleFiles(setTemplateFiles, false, MAX_TEMPLATE_BYTES)} />
                  <Plus size={27} />
                  <strong>{templateFiles.length ? 'Replace DRF Excel template' : 'Upload DRF Excel template'}</strong>
                  <span>The current template mapping uses the actual DRF cells from the uploaded iRipple workbook, including the POS device rows and three signatory blocks.</span>
                </label>
                <FileSummary files={templateFiles} />
                <div className="document-info-note"><Inbox size={16} /><span>The generated DRF stays in Excel format and keeps the template layout, formatting, logo, merged cells, and untouched iRipple-only columns.</span></div>
              </div>
            </div>

            <div className="document-drf-config-grid">
              <div className="document-extraction-panel">
                <div className="document-section-title"><Clipboard size={18} /><div><strong>3. COR extracted details</strong><span>These four values come from the COR and can be corrected before generation.</span></div></div>
                <div className="document-field-grid">
                  <label>Business / Registered Name<input value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder="Name of Taxpayer / registered name" /></label>
                  <label>Trade / Business Name<input value={tradeName} onChange={(event) => setTradeName(event.target.value)} placeholder="Trade Name from COR" /></label>
                  <label>TIN<input value={tin} onChange={(event) => setTin(event.target.value)} placeholder="TIN / branch code exactly as shown" /></label>
                  <label className="document-field-wide">Registered Address<textarea value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Registered business address" rows={3} /></label>
                </div>

                <div className="document-subsection">
                  <div className="document-subsection-heading"><div><strong>DRF details</strong><span>Fields from the Excel form that are not extracted from the COR.</span></div></div>
                  <div className="document-field-grid document-drf-fields">
                    <label>Branch Name<input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="e.g. iRipple - Ortigas Pasig" /></label>
                    <label>Request Date<input value={requestDate} readOnly className="document-readonly-input" title="Automatically set to the date this DRF is created" /></label>
                    <label>GO-LIVE Date<input value={goLiveDate} onChange={(event) => setGoLiveDate(event.target.value)} placeholder="MM/DD/YYYY or TBA" /></label>
                    <label>Contract Number (SLSS-DRF)<input value={contractNumber} onChange={(event) => setContractNumber(event.target.value)} placeholder="Contract / SLSS-DRF reference" /></label>
                    <label>Request For<select value={requestFor} onChange={(event) => setRequestFor(event.target.value)}>{REQUEST_FOR_OPTIONS.map((option) => <option value={option} key={option}>{option}</option>)}</select></label>
                    <label>Dongle<input value={dongle} onChange={(event) => setDongle(event.target.value)} placeholder="n/a, NEW, REPLACEMENT, DONGLELESS" /></label>
                    <label>License For<input value={licenseFor} onChange={(event) => setLicenseFor(event.target.value)} placeholder="BARTER RPOS 5.1 (CORE)" /></label>
                    <label>POS Setup<input value={posSetup} onChange={(event) => setPosSetup(event.target.value)} placeholder="STANDALONE" /></label>
                    <label className="document-field-wide">Notes / Instructions<textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional notes/instructions" rows={2} /></label>
                    <label className="document-field-wide">Request Note<input value={requestNote} onChange={(event) => setRequestNote(event.target.value)} placeholder="Optional note shown on the DRF" /></label>
                  </div>
                </div>
              </div>

              <div className="document-extraction-panel">
                <div className="document-section-title"><UserRound size={18} /><div><strong>4. Signatories</strong><span>These map to the three main signatory blocks at the bottom of the Excel DRF.</span></div></div>
                <div className="document-signatory-list">
                  {signatories.map((signatory, index) => (
                    <div className="document-signatory-card" key={index}>
                      <div className="document-signatory-number">{index + 1}</div>
                      <div className="document-signatory-fields">
                        <label>Label<input value={signatory.label} onChange={(event) => updateSignatory(index, { label: event.target.value })} placeholder="Prepared By" /></label>
                        <label>Name<input value={signatory.name} onChange={(event) => updateSignatory(index, { name: event.target.value })} placeholder="Signatory name" /></label>
                        <label>Title / Position<input value={signatory.title} onChange={(event) => updateSignatory(index, { title: event.target.value })} placeholder="Account Manager" /></label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="document-template-guide">
                  <strong>Mapped Excel areas</strong>
                  <span>Company details → rows 3–8 · request details → rows 3–13 · POS rows → rows 16–32 · signatories → rows 39–41. iRipple-only columns for POS MIN, Permit Number, and License Serial Key are preserved and left untouched.</span>
                </div>
              </div>
            </div>

            <div className="document-pos-panel">
              <div className="document-subsection-heading">
                <div><strong>5. POS / Computer Rows</strong><span>Add one row per machine. The current DRF template provides {MAX_POS_ROWS} rows (Excel rows 16–32).</span></div>
                <button type="button" className="secondary compact" disabled={posRows.length >= MAX_POS_ROWS} onClick={() => setPosRows((current) => [...current, newPosRow()])}><Plus size={14} /> Add row</button>
              </div>
              <div className="document-pos-table-wrap">
                <table className="document-pos-table">
                  <thead><tr><th>#</th><th>Computer Name</th><th>POS Machine Serial No.</th><th>Machine Brand</th><th>Machine Model</th><th></th></tr></thead>
                  <tbody>
                    {posRows.map((row, index) => (
                      <tr key={row.id}>
                        <td>{index + 1}</td>
                        <td><input maxLength={12} value={row.computerName} onChange={(event) => updatePosRow(row.id, { computerName: event.target.value.toUpperCase() })} placeholder="PC01" /></td>
                        <td><input value={row.serialNo} onChange={(event) => updatePosRow(row.id, { serialNo: event.target.value })} placeholder="Serial number" /></td>
                        <td><input value={row.brand} onChange={(event) => updatePosRow(row.id, { brand: event.target.value })} placeholder="Brand" /></td>
                        <td><input value={row.model} onChange={(event) => updatePosRow(row.id, { model: event.target.value })} placeholder="Model" /></td>
                        <td><button type="button" className="icon-button danger" title="Remove row" disabled={posRows.length === 1} onClick={() => setPosRows((current) => current.filter((candidate) => candidate.id !== row.id))}><Trash2 size={15} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {(documentMessage || documentError) && <div className={`document-status-message${documentError ? ' error' : ''}`}>{documentError || documentMessage}</div>}

            <div className="document-generate-bar">
              <div><strong>6. Generate DRF</strong><span>The reviewed values are written into the uploaded Excel template and downloaded as a new .xlsx file.</span></div>
              <button type="button" className="primary" disabled={!templateFile || generating} onClick={generateDrf}><Download size={16} /> {generating ? 'Generating…' : 'Generate & Download DRF'}</button>
            </div>
          </div>
        )}

        {flow === 'fsd' && (
          <div className="document-single-flow">
            <div className="document-upload-panel">
              <div className="document-section-title"><FileText size={18} /><div><strong>Business Requirements Document (BRD)</strong><span>A BRD is required before an FSD can be created.</span></div></div>
              <label className="document-dropzone">
                <input type="file" accept={BRD_ACCEPT} onChange={handleFiles(setBrdFiles)} />
                <Plus size={30} />
                <strong>{brdFiles.length ? 'Replace BRD file' : 'Choose BRD file'}</strong>
                <span>Accepted: PDF, DOC, DOCX, RTF, TXT</span>
              </label>
              <FileSummary files={brdFiles} />
              <div className="document-requirement-row"><span className={brdFiles.length ? 'requirement-ok' : 'requirement-pending'}>{brdFiles.length ? 'BRD attached' : 'BRD required'}</span><button type="button" className="primary" disabled={!brdFiles.length}>Generate FSD</button></div>
              <p className="document-action-help">The FSD generator will be wired to the BRD structure and your approved FSD output once you provide them.</p>
            </div>
          </div>
        )}

        {flow === 'signoff' && (
          <div className="document-single-flow">
            <div className="document-upload-panel">
              <div className="document-section-title"><FileText size={18} /><div><strong>Supporting documents</strong><span>Add one or more documents that should accompany the sign-off form.</span></div></div>
              <label className="document-dropzone">
                <input type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={handleFiles(setSignoffFiles, true)} />
                <Plus size={30} />
                <strong>{signoffFiles.length ? 'Replace selected attachments' : 'Choose attachments'}</strong>
                <span>PDF, Office documents, spreadsheets, presentations, images, text files, and ZIP files are accepted for intake.</span>
              </label>
              <FileSummary files={signoffFiles} />
              <div className="document-action-row document-signoff-actions"><button type="button" className="primary" disabled><CheckCircle2 size={16} /> Create Sign Off Form</button></div>
              <p className="document-action-help">Attachment storage and final sign-off generation will be enabled when you provide the required sign-off form/output.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
