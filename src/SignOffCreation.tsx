import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Download, Trash2 } from 'lucide-react'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import DocumentReset from './DocumentReset'
import { useDocumentOperation } from './useDocumentOperation'
import type { Client, Project, WorkItem } from './types'
import { DocHubOptions, DocHubResult, useDocHubDraft } from './DocHubPanel'
import { DEPLOYMENT_TYPES, DEPLOYED_PRODUCTS, SIGNOFF_MAX_ATTACHMENTS, SIGNOFF_MAX_FILE_BYTES, SIGNOFF_MAX_TOTAL_BYTES, SIGNOFF_TITLE, SIGNOFF_PURPOSE, SIGNOFF_SCOPE, SIGNOFF_AUTHORIZATION, formatDeploymentDate, signoffReference, type SignoffInput, type SignoffAttachment } from './signoff'

type Upload = SignoffAttachment & { id: string; size: number; image: boolean }
const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip'
const emptyPeople = () => Array.from({ length: 3 }, () => ({ name: '', title: '' }))
function initialDetails(): SignoffInput {
  const now = new Date(), year = String(now.getFullYear())
  return { clientName: '', site: '', deploymentDate: `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, deploymentType: DEPLOYMENT_TYPES[0], product: DEPLOYED_PRODUCTS[0], documentYear: year, documentNumber: '1', irippleSignatories: emptyPeople(), clientSignatories: emptyPeople() }
}
function base64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the attachment.')); reader.readAsDataURL(file)
  })
}
async function prepareUpload(file: File): Promise<Upload> {
  if (file.size > SIGNOFF_MAX_FILE_BYTES || !file.size) throw new Error(`${file.name}: choose a non-empty file up to 5 MB.`)
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  if (!ACCEPT.split(',').includes(`.${ext}`)) throw new Error(`${file.name}: unsupported attachment format.`)
  let content: Blob = file, name = file.name
  const image = ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
  if (image) {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error(`${file.name}: this image could not be opened.`) })
    try {
      const ratio = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
      const context = canvas.getContext('2d'); if (!context) throw new Error('Image preparation is unavailable in this browser.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const format = ['jpg', 'jpeg'].includes(ext) ? 'image/jpeg' : 'image/png'
      content = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image preparation failed.')), format, .92))
      name = file.name.replace(/\.[^.]+$/, format === 'image/jpeg' ? '.jpg' : '.png')
    } finally { bitmap.close() }
  }
  if (content.size > SIGNOFF_MAX_FILE_BYTES) throw new Error(`${file.name}: prepared image exceeds 5 MB. Choose a smaller image.`)
  return { id: crypto.randomUUID(), name, data: await base64(content), caption: '', size: content.size, image }
}
export default function SignOffCreation({ clients, projects, items, launch, canGenerate, templateReady }: { clients: Client[]; projects: Project[]; items: WorkItem[]; launch?: {taskId:string;flow:'drf'|'signoff';nonce:number}; canGenerate: boolean; templateReady: boolean }) {
  const docHub=useDocHubDraft('Sign-Off')
  const [emails,setEmails]=useState({irippleSignatories:['','',''],clientSignatories:['','','']})
  useEffect(()=>{if(launch?.flow!=='signoff')return;const task=items.find(i=>i.id===launch.taskId);docHub.setOptions(o=>({...o,taskId:launch.taskId,clientId:task?.clientId || ''}));const client=clients.find(c=>c.id===task?.clientId);if(client)setDetails(d=>({...d,clientName:client.name}))},[launch])
  const [details, setDetails] = useState(initialDetails)
  const [files, setFiles] = useState<Upload[]>([])
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const operation = useDocumentOperation()
  const fileInput = useRef<HTMLInputElement>(null)
  const reset = () => {
    operation.cancel();docHub.reset()
    setDetails(initialDetails());setFiles([]);setEmails({irippleSignatories:['','',''],clientSignatories:['','','']})
    setBusy(false);setUploading(false);setError('');setMessage('')
    if(fileInput.current)fileInput.current.value=''
  }
  const update = (key: keyof SignoffInput, value: string) => setDetails(previous => ({ ...previous, [key]: value }))
  const person = (side: 'irippleSignatories' | 'clientSignatories', index: number, key: 'name' | 'title', value: string) => setDetails(previous => ({ ...previous, [side]: previous[side].map((p, i) => i === index ? { ...p, [key]: value } : p) }))
  const addFiles = async (selected: File[]) => {
    if (!selected.length || busy || uploading || docHub.busy) return
    const job = operation.begin()
    setError(''); setMessage(''); setUploading(true)
    try {
      if (files.length + selected.length > SIGNOFF_MAX_ATTACHMENTS) throw new Error(`Use up to ${SIGNOFF_MAX_ATTACHMENTS} attachments.`)
      const prepared: Upload[] = []
      for (const file of selected) {
        if (!job.isCurrent()) return
        prepared.push(await prepareUpload(file))
        if (!job.isCurrent()) return
      }
      if ([...files, ...prepared].reduce((sum, file) => sum + file.size, 0) > SIGNOFF_MAX_TOTAL_BYTES) throw new Error('Attachments must total 12 MB or less.')
      setFiles(previous => [...previous, ...prepared])
    } catch (e) { if(job.isCurrent())setError((e as Error).message) } finally { if(job.isCurrent())setUploading(false) }
  }
  const move = (index: number, delta: number) => setFiles(previous => { const next = [...previous]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; return next })
  const generate = async (event: FormEvent) => {
    event.preventDefault(); if (!canGenerate || !templateReady || busy || uploading || docHub.busy) return
    const signers=(['irippleSignatories','clientSignatories'] as const).flatMap(side=>details[side].map((p,i)=>({...p,email:emails[side][i],label:side==='irippleSignatories'?'iRipple':'Client'})))
    try { docHub.validate(signers) } catch(e) { setError((e as Error).message); return }
    const job = operation.begin()
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/documents/signoff/generate', { signal: job.signal, method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details, attachments: files.map(({ name, data, caption }) => ({ name, data, caption })) }) })
      const result = await response.json().catch(() => ({}))
      if (!job.isCurrent()) return
      if (!response.ok) throw new Error(result.error || 'Sign Off generation failed. Please retry.')
      const bytes = Uint8Array.from(atob(result.fileData), c => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
      const link = document.createElement('a'); link.href = url; link.download = result.fileName; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      await docHub.prepare(result.signingFile || result, signers)
      if (!job.isCurrent()) return
      setMessage(`Downloaded ${result.fileName}. ${result.imageCount} image(s) embedded; ${result.attachmentCount} attachment(s) included.`)
    } catch (e) { if(job.isCurrent())setError((e as Error).message) } finally { if(job.isCurrent())setBusy(false) }
  }
  let shownDate = ''
  try { shownDate = formatDeploymentDate(details.deploymentDate) } catch { /* Browser date input can be empty while editing. */ }
  return <form className="signoff-form document-drf-stack" onSubmit={generate}>
    <DocumentReset label="Sign Off" onReset={reset} disabled={!canGenerate} />
    {!canGenerate && <p role="status">Your role can view this form. An Administrator or Contributor with Document Creation access can generate it.</p>}
    {!templateReady && <p role="status">The Sign Off template is not configured. An Administrator can add or restore it in Settings → Templates.</p>}
    <fieldset disabled={!canGenerate || !templateReady || busy || uploading || docHub.busy}>
      <div className="document-extraction-panel"><h3>1. Client and deployment details</h3><div className="document-field-grid">
        <label className="document-field-wide">Client name<input required maxLength={150} list="signoff-clients" value={details.clientName} onChange={e => update('clientName', e.target.value)} placeholder="Choose an existing client or enter a client name" /><datalist id="signoff-clients">{clients.map(c => <option key={c.id} value={c.name} />)}</datalist><small>Used in the header reference, client heading, client approval section, and Client Name row.</small></label>
        <label>Target Deployment Date (MM/DD/YYYY)<input type="date" required min="1900-01-01" max="9999-12-31" value={details.deploymentDate} onChange={e => update('deploymentDate', e.target.value)} /><small>Document date: {shownDate || 'Select a date'}</small></label>
        <label>Deployment type<select value={details.deploymentType} onChange={e => update('deploymentType', e.target.value)}>{DEPLOYMENT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Product deployed<select value={details.product} onChange={e => update('product', e.target.value)}>{DEPLOYED_PRODUCTS.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Site code / name<input required maxLength={160} value={details.site} onChange={e => update('site', e.target.value)} placeholder="Enter the site code or name" /></label>
        <label>Document year<input type="number" required min={1900} max={9999} value={details.documentYear} onChange={e => update('documentYear', e.target.value)} /></label>
        <label>Document number<input type="number" required min={1} max={9999} value={details.documentNumber} onChange={e => update('documentNumber', e.target.value)} /><small>Set the number for this document; it is not automatically incremented.</small></label>
      </div><div className="signoff-header-preview"><strong>{SIGNOFF_TITLE}</strong><span>{signoffReference(details.clientName, details.documentYear, details.documentNumber)}</span><small>The Word document uses the original iRipple logo and header.</small></div></div>
      <div className="document-extraction-panel"><h3>2. Agreed and Approved by</h3><p>Three signatories per side. Enter each name and position; leave unused slots blank. Signature and signing-date lines remain blank for approval.</p><div className="signoff-approval-grid">{(['irippleSignatories', 'clientSignatories'] as const).map(side => <section key={side}><h4>{side === 'irippleSignatories' ? 'IRIPPLE, INC' : details.clientName || 'Client'}</h4>{details[side].map((p, index) => <div className="signoff-person" key={index}><strong>Signatory {index + 1}</strong><label>Name<input maxLength={100} value={p.name} onChange={e => person(side, index, 'name', e.target.value)} /></label><label>Email (DocHub only)<input type="email" value={emails[side][index]} onChange={e=>setEmails(old=>({...old,[side]:old[side].map((value,i)=>i===index?e.target.value:value)}))} /></label><label>Position / title<input maxLength={100} value={p.title} onChange={e => person(side, index, 'title', e.target.value)} /></label></div>)}</section>)}</div></div>
      <div className="document-extraction-panel"><h3>3. Retained document sections</h3><p>These sections keep the wording from your supplied template.</p>{[['Purpose', SIGNOFF_PURPOSE], ['Scope', SIGNOFF_SCOPE], ['Deployment Authorization', SIGNOFF_AUTHORIZATION]].map(([title, content]) => <details className="signoff-retained" key={title}><summary>{title}</summary><p>{content}</p></details>)}</div>
      <div className="document-extraction-panel"><h3>4. Attachments</h3><p>JPEG, PNG, and WEBP images appear on attachment pages in Word. Other supporting files are supplied with the Word form in a ZIP. Up to 5 MB per file, 12 MB total, and {SIGNOFF_MAX_ATTACHMENTS} files.</p><label>Add attachments<input ref={fileInput} type="file" multiple accept={ACCEPT} onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ''; if (selected.length) void addFiles(selected) }} /></label>
        <div className="signoff-attachments">{files.map((file, index) => <div className="signoff-attachment" key={file.id}>{file.image && <img src={`data:image/${file.name.endsWith('.png') ? 'png' : 'jpeg'};base64,${file.data}`} alt={`Attachment ${index + 1} preview`} />}<div><strong>{index + 1}. {file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB · {file.image ? 'Embedded in Word' : 'Included in ZIP'}</small><label>Caption (optional)<input maxLength={200} value={file.caption} onChange={e => setFiles(previous => previous.map(f => f.id === file.id ? { ...f, caption: e.target.value } : f))} /></label><div className="signoff-attachment-actions"><button type="button" className="secondary compact" disabled={index === 0} aria-label={`Move attachment ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="secondary compact" disabled={index === files.length - 1} aria-label={`Move attachment ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button type="button" className="secondary compact" aria-label={`Remove attachment ${index + 1}`} onClick={() => setFiles(previous => previous.filter(f => f.id !== file.id))}><Trash2 size={16} /> Remove</button></div></div></div>)}</div>
        <small>Images are resized to fit the document. This form is a session draft: download before leaving or refreshing. Files are processed for generation and are not saved as account records.</small>
      </div>
      <DocHubOptions key={docHub.resetVersion} draft={docHub} clients={clients} projects={projects} items={items} disabled={!canGenerate || busy || uploading || docHub.busy} />
      <div className="document-generate-bar"><div><strong>5. Generate Sign Off</strong><span>{files.some(f => !f.image) ? 'Downloads a ZIP containing the Word form and supporting files.' : 'Downloads an editable Word form with your uploaded images.'}</span></div><button className="primary" type="submit"><Download size={16} />{busy ? 'Generating…' : uploading ? 'Preparing attachments…' : docHub.enabled ? 'Generate & Prepare in DocHub' : 'Generate & Download Sign Off'}</button></div>
    </fieldset>
    <DocHubResult draft={docHub} />
    <DocumentProcessingPanel state={error?'error':(busy||uploading)?'working':message?'success':'idle'} title={error?'Sign Off processing failed':busy?'Generating your Sign Off…':uploading?'Preparing attachments…':'Sign Off package is ready'} detail={error||message} stages={['Preparing attachments','Mapping form information','Generating document package','Starting download']} activeStage={uploading?0:busy?2:3}/>
  </form>
}
