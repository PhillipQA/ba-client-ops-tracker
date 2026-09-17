import { useMemo, useState } from 'react'
import {
  BriefcaseBusiness,
  CheckCircle2,
  Clipboard,
  FileText,
  Inbox,
  Plus,
} from 'lucide-react'

type DocumentFlow = 'drf' | 'fsd' | 'signoff'

type SelectedFile = {
  name: string
  size: number
  type: string
}

const COR_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.doc,.docx'
const BRD_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt'
const ATTACHMENT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.txt,.zip'

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function toSelectedFiles(list: FileList | null): SelectedFile[] {
  if (!list) return []
  return Array.from(list).map((file) => ({ name: file.name, size: file.size, type: file.type || 'Unknown type' }))
}

function FileSummary({ files }: { files: SelectedFile[] }) {
  if (!files.length) return null
  return (
    <div className="document-file-list">
      {files.map((file, index) => (
        <div className="document-file-row" key={`${file.name}-${file.size}-${index}`}>
          <FileText size={16} />
          <div><strong>{file.name}</strong><span>{formatBytes(file.size)} · {file.type}</span></div>
          <CheckCircle2 size={16} className="document-file-check" />
        </div>
      ))}
    </div>
  )
}

export default function DocumentCreation() {
  const [flow, setFlow] = useState<DocumentFlow>('drf')
  const [corFiles, setCorFiles] = useState<SelectedFile[]>([])
  const [brdFiles, setBrdFiles] = useState<SelectedFile[]>([])
  const [signoffFiles, setSignoffFiles] = useState<SelectedFile[]>([])
  const [businessName, setBusinessName] = useState('')
  const [tradeName, setTradeName] = useState('')
  const [tin, setTin] = useState('')
  const [address, setAddress] = useState('')

  const selectedTitle = useMemo(() => flow === 'drf' ? 'DRF Creation' : flow === 'fsd' ? 'FSD Creation' : 'Sign Off Form', [flow])

  const handleFiles = (setter: (files: SelectedFile[]) => void, multiple = false) => (event: any) => {
    const files = toSelectedFiles(event.target.files)
    setter(multiple ? files : files.slice(0, 1))
  }

  return (
    <section className="page-stack document-creation-page">
      <div className="callout document-module-callout">
        <FileText size={23} />
        <div>
          <strong>Document Creation</strong>
          <p>Create BA delivery documents from source files. This first version sets up the intake flows; extraction and generated output will be connected when the approved document templates are provided.</p>
        </div>
      </div>

      <div className="document-flow-grid">
        <button type="button" className={`document-flow-card${flow === 'drf' ? ' active' : ''}`} onClick={() => setFlow('drf')}>
          <div className="document-flow-icon"><BriefcaseBusiness size={22} /></div>
          <div><strong>DRF Creation</strong><span>Read company COR details and prepare a DRF.</span></div>
          <small>COR required</small>
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
          <div><h2>{selectedTitle}</h2><p>{flow === 'drf' ? 'Upload the company COR. The extraction step will populate the required business details before the DRF is generated.' : flow === 'fsd' ? 'Upload the BRD that will serve as the required source document for the FSD.' : 'Add the documents that will be included with or referenced by the sign-off form.'}</p></div>
          <span className="document-stage-pill">Template pending</span>
        </div>

        {flow === 'drf' && (
          <div className="document-workspace-grid">
            <div className="document-upload-panel">
              <div className="document-section-title"><FileText size={18} /><div><strong>Company COR</strong><span>Accepted: PDF, JPEG, PNG, WEBP, TIFF, DOC, DOCX</span></div></div>
              <label className="document-dropzone">
                <input type="file" accept={COR_ACCEPT} onChange={handleFiles(setCorFiles)} />
                <Plus size={30} />
                <strong>{corFiles.length ? 'Replace COR file' : 'Choose a COR file'}</strong>
                <span>Browse from your computer. OCR/extraction will be connected in the next document-processing phase.</span>
              </label>
              <FileSummary files={corFiles} />
              <div className="document-info-note"><Inbox size={16} /><span>The uploaded file is only selected in this browser in this scaffold version. It is not yet stored or sent for extraction.</span></div>
            </div>

            <div className="document-extraction-panel">
              <div className="document-section-title"><Clipboard size={18} /><div><strong>COR extracted details</strong><span>These are the fields the COR reader will populate.</span></div></div>
              <div className="document-field-grid">
                <label>Business Name<input value={businessName} onChange={(event: any) => setBusinessName(event.target.value)} placeholder="Business name from COR" /></label>
                <label>Trade Name<input value={tradeName} onChange={(event: any) => setTradeName(event.target.value)} placeholder="Trade name from COR" /></label>
                <label>TIN<input value={tin} onChange={(event: any) => setTin(event.target.value)} placeholder="Tax Identification Number" /></label>
                <label className="document-field-wide">Address<textarea value={address} onChange={(event: any) => setAddress(event.target.value)} placeholder="Registered business address" rows={3} /></label>
              </div>
              <div className="document-action-row">
                <button type="button" className="secondary" disabled><Clipboard size={16} /> Extract COR details</button>
                <button type="button" className="primary" disabled><CheckCircle2 size={16} /> Generate DRF</button>
              </div>
              <p className="document-action-help">Extraction and DRF generation will be enabled after the approved DRF output/template is provided.</p>
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
