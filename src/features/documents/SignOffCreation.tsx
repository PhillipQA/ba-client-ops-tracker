import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, Download, Plus, Trash2 } from 'lucide-react'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import DocumentReset from './DocumentReset'
import { useDocumentOperation } from './useDocumentOperation'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'
import { PersonNameInput } from '../../shared/ui/PersonNameInput'
import { knownPeople } from '../../shared/knownPeople'
import { DocHubOptions, DocHubResult, useDocHubDraft } from './DocHubPanel'
import { documentOutputName, suggestedDocumentStem, type DocumentKind } from './documentFilename'
import { DEPLOYMENT_TYPES, DEPLOYED_PRODUCTS, SIGNOFF_FORM_LABELS, SIGNOFF_FORM_TYPES, SIGNOFF_MAX_ATTACHMENTS, SIGNOFF_MAX_FILE_BYTES, SIGNOFF_MAX_TOTAL_BYTES, SIGNOFF_TABLE_MAX_ROWS, GO_LIVE_TYPES, SIGNOFF_MAX_SIGNATORIES, extraSignoffForm, signoffFieldDefaults, signoffSectionDefaults, signoffSectionFields, signoffTableDefaults, signoffTitle, type SignoffColumnDef, type SignoffFieldDef, type SignoffFormType, type SignoffTableDef, formatDeploymentDate, signoffReference, type SignoffInput, type SignoffAttachment } from './signoff'

type Upload = SignoffAttachment & { id: string; size: number; image: boolean }
const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip'
const emptyPeople = () => Array.from({ length: 2 }, () => ({ name: '', title: '' }))
const FILENAME_KIND: Record<SignoffFormType, DocumentKind> = { production: 'SO', golive: 'SO', uat: 'UAT', uatdeploy: 'UAD', training: 'TRN' }
const LONG_SECTIONS = new Set(['activities_completed', 'defects_classification', 'acceptance_criteria', 'training_objectives'])
const SECTION_PLACEHOLDERS: Record<string, string> = {
  branches_live: 'Branch name — MM/DD/YYYY, one branch per line',
  known_issues: 'Enter None or list known issues',
  activities_completed: 'List the activities completed before and after go live',
  receipt_validation: 'Sales invoice, terminal readings, X-reading if applicable, initial and first Z-reading',
  mall_integration: 'Enter Not applicable or confirm setup screenshots and received text files',
  scope_of_uat: 'Modules and scenarios covered by the UAT, one per line',
  training_participants: 'Who attended the training, one per line',
  training_scope: 'Topics and modules covered by the training',
  training_materials: 'Manuals, slides or guides handed to the participants',
  training_modules: 'Modules included in the training',
}
const sectionPlaceholder = (formType: SignoffFormType, key: string) => key === 'scope' && formType === 'uatdeploy' ? 'What is included in this deployment, one item per line' : SECTION_PLACEHOLDERS[key] || ''
function initialDetails(formType: SignoffFormType = 'production'): SignoffInput {
  const now = new Date(), year = String(now.getFullYear())
  const today = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { formType, sections: signoffSectionDefaults(formType), fields: signoffFieldDefaults(formType, today), tables: signoffTableDefaults(formType), projectName: '', preparedBy: '', documentDate: today, goLiveType: GO_LIVE_TYPES[0], clientName: '', site: '', deploymentDate: today, deploymentType: DEPLOYMENT_TYPES[0], product: DEPLOYED_PRODUCTS[0], documentYear: year, documentNumber: '1', irippleSignatories: emptyPeople(), clientSignatories: emptyPeople() }
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
type SignOffProps = { active?: boolean; clients: Client[]; projects: Project[]; accounts?: UserAccount[]; items: WorkItem[]; launch?: {taskId:string;flow:'drf'|'signoff';nonce:number}; canGenerate: boolean; templateReady: Partial<Record<SignoffFormType, boolean>> }
type SignOffFormProps = Omit<SignOffProps, 'templateReady'> & { templateReady: boolean; formType: SignoffFormType; onWorking: (type: SignoffFormType, working: boolean) => void }
export default function SignOffCreation({ templateReady, ...props }: SignOffProps) {
  const [formType,setFormType] = useState<SignoffFormType>('production')
  const [working,setWorking] = useState<Record<SignoffFormType, boolean>>({ production:false, golive:false, uat:false, uatdeploy:false, training:false })
  const onWorking = useCallback((type:SignoffFormType,value:boolean)=>setWorking(old=>old[type]===value?old:{...old,[type]:value}),[])
  const anyWorking = Object.values(working).some(Boolean)
  return <div><h2>Sign Off Document</h2><div className="signoff-form-toggle" role="group" aria-label="Sign Off document type">
    {SIGNOFF_FORM_TYPES.map(type=><button key={type} type="button" className={formType===type?'primary':'secondary'} aria-pressed={formType===type} disabled={anyWorking} onClick={()=>setFormType(type)}>{SIGNOFF_FORM_LABELS[type]}</button>)}
  </div><p>Each form retains its own details, edited sections, signatories, attachments and DocHub preparation while you switch.</p>
  {SIGNOFF_FORM_TYPES.map(type=><div key={type} hidden={formType!==type}><SignOffForm {...props} formType={type} onWorking={onWorking} active={Boolean((props.active??true)&&formType===type)} templateReady={Boolean(templateReady[type])}/></div>)}
  </div>
}
function SignOffForm({ clients, projects, accounts, items, launch, canGenerate, templateReady, active=true, formType, onWorking }: SignOffFormProps) {
  const extra = extraSignoffForm(formType)
  const label = SIGNOFF_FORM_LABELS[formType]
  const sectionFields = signoffSectionFields(formType)
  // Go Live and the Prepared By / Date header forms capture a project name, author and document date.
  const prepared = formType==='golive' || extra?.header==='prepared'
  const hasDate = !extra || Boolean(extra.dateLabel)
  const dateLabel = formType==='golive' ? 'Go Live Date' : extra?.dateLabel || 'Target Deployment Date'
  const detailsHeading = formType==='production' ? 'Client and deployment' : formType==='golive' ? 'Go Live' : label
  const tableStep = extra?.tables.length ? 4 : 0
  const attachmentsStep = tableStep ? 5 : 4
  const docHub=useDocHubDraft('Sign-Off',undefined,active,true)
  const [emails,setEmails]=useState({irippleSignatories:['',''],clientSignatories:['','']})
  useEffect(()=>{if(launch?.flow!=='signoff')return;const task=items.find(i=>i.id===launch.taskId);docHub.setOptions(o=>({...o,taskId:launch.taskId,clientId:task?.clientId || ''}));const client=clients.find(c=>c.id===task?.clientId);if(client)setDetails(d=>({...d,clientName:client.name}))},[launch])
  const [details, setDetails] = useState(()=>initialDetails(formType))
  const [fileNameOverride,setFileNameOverride]=useState<string | undefined>()
  const nameSource = formType==='production' ? details.site : formType==='uatdeploy' ? details.fields?.enhancement_name || '' : details.projectName || ''
  const suggestedFileName=suggestedDocumentStem(FILENAME_KIND[formType],details.clientName,nameSource)
  const fileName=fileNameOverride ?? suggestedFileName
  const [files, setFiles] = useState<Upload[]>([])
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  useEffect(()=>onWorking(formType,busy||uploading||docHub.busy),[formType,busy,uploading,docHub.busy,onWorking])
  const operation = useDocumentOperation()
  const fileInput = useRef<HTMLInputElement>(null)
  const reset = () => {
    operation.cancel();docHub.reset()
    setDetails(initialDetails(formType));setFileNameOverride(undefined);setFiles([]);setEmails({irippleSignatories:['',''],clientSignatories:['','']})
    setBusy(false);setUploading(false);setError('');setMessage('')
    if(fileInput.current)fileInput.current.value=''
  }
  const update = (key: keyof SignoffInput, value: string) => setDetails(previous => ({ ...previous, [key]: value }))
  const setField = (key: string, value: string) => setDetails(previous => ({ ...previous, fields: { ...previous.fields, [key]: value } }))
  const fieldValue = (key: string) => details.fields?.[key] ?? ''
  const setCell = (tableKey: string, rowIndex: number, columnKey: string, value: string) => setDetails(previous => ({ ...previous, tables: { ...previous.tables, [tableKey]: (previous.tables?.[tableKey] || []).map((row, i) => i === rowIndex ? { ...row, [columnKey]: value } : row) } }))
  const addRow = (table: SignoffTableDef) => setDetails(previous => {
    const rows = previous.tables?.[table.key] || []
    return rows.length >= SIGNOFF_TABLE_MAX_ROWS ? previous : { ...previous, tables: { ...previous.tables, [table.key]: [...rows, Object.fromEntries(table.columns.map(column => [column.key, '']))] } }
  })
  const removeRow = (table: SignoffTableDef, rowIndex: number) => setDetails(previous => {
    const rows = previous.tables?.[table.key] || []
    return rows.length <= 1 ? previous : { ...previous, tables: { ...previous.tables, [table.key]: rows.filter((_, i) => i !== rowIndex) } }
  })
  const renderField = (field: SignoffFieldDef) => {
    const listId = `signoff-${formType}-${field.key}-options`
    if (field.control === 'daterange') return <Fragment key={field.key}>
      <label>{field.label} — start (MM/DD/YYYY)<input type="date" required={field.required} min="1900-01-01" max="9999-12-31" value={fieldValue(`${field.key}_start`)} onChange={e => setField(`${field.key}_start`, e.target.value)} />{field.help && <small>{field.help}</small>}</label>
      <label>{field.label} — end (optional)<input type="date" min={fieldValue(`${field.key}_start`) || '1900-01-01'} max="9999-12-31" value={fieldValue(`${field.key}_end`)} onChange={e => setField(`${field.key}_end`, e.target.value)} /></label>
    </Fragment>
    return <label key={field.key} className={field.control === 'text' && (field.max ?? 0) >= 150 ? 'document-field-wide' : undefined}>{field.label}
      {field.control === 'select'
        ? <select required={field.required} value={fieldValue(field.key)} onChange={e => setField(field.key, e.target.value)}>{field.initial === '' && <option value="">Select…</option>}{field.options?.map(value => <option key={value}>{value}</option>)}</select>
        : field.control === 'date'
          ? <input type="date" required={field.required} min="1900-01-01" max="9999-12-31" value={fieldValue(field.key)} onChange={e => setField(field.key, e.target.value)} />
          : <input required={field.required} maxLength={field.max ?? 300} list={field.control === 'suggest' ? listId : undefined} value={fieldValue(field.key)} placeholder={field.placeholder} onChange={e => setField(field.key, e.target.value)} />}
      {field.control === 'suggest' && <datalist id={listId}>{field.options?.map(value => <option key={value} value={value} />)}</datalist>}
      {field.help && <small>{field.help}</small>}
    </label>
  }
  const renderCell = (table: SignoffTableDef, row: Record<string, string>, rowIndex: number, column: SignoffColumnDef) => {
    const aria = `${table.label} row ${rowIndex + 1} ${column.label}`, value = row[column.key] ?? ''
    if (column.control === 'select') return <select aria-label={aria} value={value} onChange={e => setCell(table.key, rowIndex, column.key, e.target.value)}><option value="">—</option>{column.options?.map(option => <option key={option}>{option}</option>)}</select>
    if (column.control === 'date') return <input type="date" aria-label={aria} min="1900-01-01" max="9999-12-31" value={value} onChange={e => setCell(table.key, rowIndex, column.key, e.target.value)} />
    return <input aria-label={aria} maxLength={400} placeholder={column.placeholder} value={value} onChange={e => setCell(table.key, rowIndex, column.key, e.target.value)} />
  }
  // Clients and teammates whose email can be suggested for a signatory name.
  const people = useMemo(() => knownPeople({ clients, accounts }), [clients, accounts])
  const person = (side: 'irippleSignatories' | 'clientSignatories', index: number, key: 'name' | 'title', value: string) => setDetails(previous => ({ ...previous, [side]: previous[side].map((p, i) => i === index ? { ...p, [key]: value } : p) }))
  const addPerson = (side:'irippleSignatories'|'clientSignatories') => {
    if(details[side].length>=SIGNOFF_MAX_SIGNATORIES)return
    setDetails(old=>({...old,[side]:[...old[side],{name:'',title:''}]}))
    setEmails(old=>({...old,[side]:[...old[side],'']}))
  }
  const removePerson = (side:'irippleSignatories'|'clientSignatories',index:number) => {
    if(details[side].length<=2)return
    setDetails(old=>({...old,[side]:old[side].filter((_,i)=>i!==index)}))
    setEmails(old=>({...old,[side]:old[side].filter((_,i)=>i!==index)}))
  }
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
    if(docHub.enabled && signers.filter(s=>s.name.trim()||s.email?.trim()).length>12){setError('DocHub supports up to 12 active signatories across both sides. Reduce the signing list or turn off DocHub preparation to download only.');return}
    try { docHub.validate(signers) } catch(e) { setError((e as Error).message); return }
    const job = operation.begin()
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch('/api/documents/signoff/generate', { signal: job.signal, method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details, fileName:documentOutputName(fileName,'docx',suggestedFileName), attachments: files.map(({ name, data, caption }) => ({ name, data, caption })) }) })
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
    <DocumentReset label={label} onReset={reset} disabled={!canGenerate} />
    {!canGenerate && <p role="status">Your role can view this form. An Administrator or Contributor with Document Creation access can generate it.</p>}
    {!templateReady && <p role="status">{label} template is not configured. An Administrator can add or restore it in Settings → Templates.</p>}
    <fieldset disabled={!canGenerate || !templateReady || busy || uploading || docHub.busy}>
      <div className="document-extraction-panel"><h3>1. {detailsHeading} details</h3><div className="document-field-grid">
        <label className="document-field-wide">Client name<input required maxLength={150} list={`signoff-clients-${formType}`} value={details.clientName} onChange={e => update('clientName', e.target.value)} placeholder="Choose an existing client or enter a client name" /><datalist id={`signoff-clients-${formType}`}>{[...clients].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })).map(c => <option key={c.id} value={c.name} />)}</datalist><small>Used in the header reference, client heading, client approval section, and Client Name row.</small></label>
        {hasDate && <label>{dateLabel} (MM/DD/YYYY)<input type="date" required min="1900-01-01" max="9999-12-31" value={details.deploymentDate} onChange={e => update('deploymentDate', e.target.value)} /><small>Document date: {shownDate || 'Select a date'}</small></label>}
        {formType==='golive'?<label>Go Live Type<select value={details.goLiveType} onChange={e=>update('goLiveType',e.target.value)}>{GO_LIVE_TYPES.map(value=><option key={value}>{value}</option>)}</select></label>:formType==='production'?<label>Deployment type<select value={details.deploymentType} onChange={e => update('deploymentType', e.target.value)}>{DEPLOYMENT_TYPES.map(value => <option key={value}>{value}</option>)}</select></label>:null}
        <label>Product deployed<select value={details.product} onChange={e => update('product', e.target.value)}>{DEPLOYED_PRODUCTS.map(value => <option key={value}>{value}</option>)}</select></label>
        {prepared?<><label className="document-field-wide">Client / Project Name<input required maxLength={180} value={details.projectName||''} onChange={e=>update('projectName',e.target.value)} placeholder="Project or deployment name"/></label><label>Prepared by<input required maxLength={150} value={details.preparedBy||''} onChange={e=>update('preparedBy',e.target.value)}/></label><label>Document date<input type="date" required min="1900-01-01" max="9999-12-31" value={details.documentDate||''} onChange={e=>update('documentDate',e.target.value)}/></label></>:formType==='production'?<label>Site code / name<input required maxLength={160} value={details.site} onChange={e => update('site', e.target.value)} placeholder="Enter the site code or name" /></label>:null}
        {extra?.fields.map(renderField)}
        <label className="document-field-wide">Filename (extension added automatically)<input aria-label="Sign Off filename" value={fileName} maxLength={150} onChange={e=>setFileNameOverride(e.target.value)} onBlur={()=>{if(!fileNameOverride?.trim())setFileNameOverride(undefined)}}/><small>Download and DocHub: {documentOutputName(fileName,files.some(f=>!f.image)?'zip':'docx',suggestedFileName)}{files.some(f=>!f.image)?` · DocHub receives ${documentOutputName(fileName,'docx',suggestedFileName)}`:''}</small></label>
        <label>Document year<input type="number" required min={1900} max={9999} value={details.documentYear} onChange={e => update('documentYear', e.target.value)} /></label>
        <label>Document number<input type="number" required min={1} max={9999} value={details.documentNumber} onChange={e => update('documentNumber', e.target.value)} /><small>Set the number for this document; it is not automatically incremented.</small></label>
      </div><div className="signoff-header-preview"><strong>{signoffTitle(formType)}</strong><span>{signoffReference(details.clientName, details.documentYear, details.documentNumber, formType)}</span><small>The Word document includes the iRipple logo, document title and reference.</small></div></div>
      <div className="document-extraction-panel"><h3>2. Agreed and Approved by</h3><p>Two signatories per side to start. Use Add signatory for additional approvers. Enter each name and position; leave unused slots blank. Signature and signing-date lines remain blank for approval.</p><div className="signoff-approval-grid">{(['irippleSignatories', 'clientSignatories'] as const).map(side => <section key={side}><h4>{side === 'irippleSignatories' ? 'IRIPPLE, INC' : details.clientName || 'Client'}</h4>{details[side].map((p, index) => <div className="signoff-person" key={index}><strong>Signatory {index + 1}</strong><PersonNameInput label="Name" maxLength={100} value={p.name} email={emails[side][index]} onName={name => person(side, index, 'name', name)} onEmail={email=>setEmails(old=>({...old,[side]:old[side].map((value,i)=>i===index?email:value)}))} local={people} /><label>Email (DocHub only)<input type="email" value={emails[side][index]} onChange={e=>setEmails(old=>({...old,[side]:old[side].map((value,i)=>i===index?e.target.value:value)}))} /></label><label>Position / title<input maxLength={100} value={p.title} onChange={e => person(side, index, 'title', e.target.value)} /></label>{details[side].length>2&&<button type="button" className="secondary" onClick={()=>removePerson(side,index)}>Remove signatory {index+1}</button>}</div>)}<button type="button" className="secondary" disabled={details[side].length>=SIGNOFF_MAX_SIGNATORIES} onClick={()=>addPerson(side)}><Plus size={16}/> Add {side==='irippleSignatories'?'iRipple':'client'} signatory</button></section>)}</div></div>
      <div className="document-extraction-panel"><h3>3. Retained document sections</h3><p>Edit the wording below. These values are included in the generated document for this form only.</p>{sectionFields.map(([key,title])=><label className="signoff-section-field" key={key}>{title}<textarea aria-label={`${label} — ${title}`} rows={LONG_SECTIONS.has(key)?9:5} maxLength={12000} value={details.sections?.[key]||''} onChange={e=>setDetails(old=>({...old,sections:{...old.sections,[key]:e.target.value}}))} placeholder={sectionPlaceholder(formType,key)}/></label>)}<button type="button" className="secondary" onClick={()=>{if(window.confirm('Restore the default section text for this form?'))setDetails(old=>({...old,sections:signoffSectionDefaults(formType)}))}}>Restore default section text</button></div>
      {extra?.tables.length ? <div className="document-extraction-panel"><h3>{tableStep}. Tables</h3><p>Type each row directly. Blank rows are left out of the document; the first row always stays so the table is never empty. Up to {SIGNOFF_TABLE_MAX_ROWS} rows per table.</p>{extra.tables.map(table => <div className="signoff-table-block" key={table.key}><h4>{table.label}</h4>{table.help && <small>{table.help}</small>}<div className="signoff-table-scroll"><table className="signoff-table-editor"><thead><tr>{table.columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}<th scope="col" aria-label="Row actions" /></tr></thead><tbody>{(details.tables?.[table.key] || []).map((row, rowIndex, rows) => <tr key={rowIndex}>{table.columns.map(column => <td key={column.key}>{renderCell(table, row, rowIndex, column)}</td>)}<td><button type="button" className="secondary compact" disabled={rows.length <= 1} aria-label={`Remove ${table.label} row ${rowIndex + 1}`} onClick={() => removeRow(table, rowIndex)}><Trash2 size={16} /></button></td></tr>)}</tbody></table></div><button type="button" className="secondary" disabled={(details.tables?.[table.key] || []).length >= SIGNOFF_TABLE_MAX_ROWS} onClick={() => addRow(table)}><Plus size={16} /> Add row</button></div>)}</div> : null}
      <div className="document-extraction-panel"><h3>{attachmentsStep}. Attachments</h3><p>JPEG, PNG, and WEBP images appear on attachment pages in Word. Other supporting files are supplied with the Word form in a ZIP. Up to 5 MB per file, 12 MB total, and {SIGNOFF_MAX_ATTACHMENTS} files.</p><label>Add attachments<input ref={fileInput} type="file" multiple accept={ACCEPT} onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ''; if (selected.length) void addFiles(selected) }} /></label>
        <div className="signoff-attachments">{files.map((file, index) => <div className="signoff-attachment" key={file.id}>{file.image && <img src={`data:image/${file.name.endsWith('.png') ? 'png' : 'jpeg'};base64,${file.data}`} alt={`Attachment ${index + 1} preview`} />}<div><strong>{index + 1}. {file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(2)} MB · {file.image ? 'Embedded in Word' : 'Included in ZIP'}</small><label>Caption (optional)<input maxLength={200} value={file.caption} onChange={e => setFiles(previous => previous.map(f => f.id === file.id ? { ...f, caption: e.target.value } : f))} /></label><div className="signoff-attachment-actions"><button type="button" className="secondary compact" disabled={index === 0} aria-label={`Move attachment ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="secondary compact" disabled={index === files.length - 1} aria-label={`Move attachment ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button type="button" className="secondary compact" aria-label={`Remove attachment ${index + 1}`} onClick={() => setFiles(previous => previous.filter(f => f.id !== file.id))}><Trash2 size={16} /> Remove</button></div></div></div>)}</div>
        <small>Images are resized to fit the document. This form is a session draft: download before leaving or refreshing. Files are processed for generation and are not saved as account records.</small>
      </div>
      <DocHubOptions key={docHub.resetVersion} draft={docHub} clients={clients} projects={projects} items={items} disabled={!canGenerate || busy || uploading || docHub.busy} />
      <div className="document-generate-bar"><div><strong>{attachmentsStep + 1}. Generate {label}</strong><span>{files.some(f => !f.image) ? 'Downloads a ZIP containing the Word form and supporting files.' : 'Downloads an editable Word form with your uploaded images.'}</span></div><button className="primary" type="submit"><Download size={16} />{busy ? 'Generating…' : uploading ? 'Preparing attachments…' : docHub.enabled ? 'Generate & Prepare in DocHub' : `Generate & Download ${label}`}</button></div>
    </fieldset>
    <DocHubResult draft={docHub} />
    <DocumentProcessingPanel state={error?'error':(busy||uploading)?'working':message?'success':'idle'} title={error?'Sign Off processing failed':busy?'Generating your Sign Off…':uploading?'Preparing attachments…':'Sign Off package is ready'} detail={error||message} stages={['Preparing attachments','Mapping form information','Generating document package','Starting download']} activeStage={uploading?0:busy?2:3}/>
  </form>
}
