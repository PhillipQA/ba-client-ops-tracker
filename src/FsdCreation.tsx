import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Layers, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { Client } from './types'
import { emptyFsdDraft, fsdReference, FSD_MODULES, FSD_NOTICE, FSD_PRESETS, FSD_SECTIONS, FSD_TEMPLATE_NAME, type FsdDraft, type FsdDetails, type FsdPreview, type FsdSource } from './fsd-model'
import { readFsdSource } from './fsd-sources'
import './fsd.css'
import DocumentProcessingPanel from './DocumentProcessingPanel'
function sourceId(sources: FsdSource[]) { return `SRC-${String(Math.max(0,...sources.map(s=>Number(s.id.replace(/^SRC-/,''))||0))+1).padStart(3,'0')}` }
type Provider = { enabled: boolean; provider?: string; name?: string; model?: string }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/documents/fsd/${path}`, { method: body ? 'POST':'GET', credentials: 'same-origin', headers: {'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)}:{}) })
  const result = await response.json().catch(()=>({}))
  if (!response.ok) throw new Error(result.error || 'The FSD request failed. Your draft is retained.')
  return result as T
}
export default function FsdCreation({ clients, canGenerate, templateReady, draftKey, active }: { clients: Client[]; canGenerate: boolean; templateReady: boolean; draftKey: string; active: boolean }) {
  const storageKey = `ba-fsd-v1:${draftKey}`
  const presetsKey = `ba-fsd-presets-v1:${draftKey}`
  const [draft, setDraft] = useState<FsdDraft>(() => {
    try { const saved = sessionStorage.getItem(storageKey); if (saved) { const value = JSON.parse(saved); if (value.details && Array.isArray(value.sources) && Array.isArray(value.customPresets)) return {...emptyFsdDraft(),...value} } } catch { /* in-memory drafts remain available when storage is blocked */ }
    const fresh = emptyFsdDraft()
    try { const presets = JSON.parse(localStorage.getItem(presetsKey) || '[]'); if (Array.isArray(presets)) fresh.customPresets = presets.filter(p => typeof p?.id === 'string' && typeof p?.name === 'string' && typeof p?.instructions === 'string').slice(0,30) } catch {}
    return fresh
  })
  const [provider,setProvider] = useState<Provider|null>(null)
  const [providerError,setProviderError] = useState('')
  const [busy,setBusy] = useState('')
  const [error,setError] = useState('')
  const [saveError,setSaveError] = useState('')
  const [presetSaveError,setPresetSaveError] = useState('')
  const [showPreview,setShowPreview] = useState(Boolean(draft.preview))
  const [editPreview,setEditPreview] = useState(false)
  const [clearConfirm,setClearConfirm] = useState(false)
  const [uploadKind,setUploadKind] = useState<FsdSource['kind']>('BRD')
  const operation = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    try { sessionStorage.setItem(storageKey,JSON.stringify(draft)); setSaveError('') }
    catch { setSaveError('Browser storage is unavailable or full. Your draft is retained while this page stays open; refresh recovery is unavailable.') }
  },[draft,storageKey])
  useEffect(() => {
    try { localStorage.setItem(presetsKey, JSON.stringify(draft.customPresets)); setPresetSaveError('') }
    catch { setPresetSaveError('Custom presets could not be saved for future sessions. They remain in this draft.') }
  }, [draft.customPresets,presetsKey])
  useEffect(() => {
    if (!active) return
    let alive = true
    request<Provider>('provider').then(value=>{ if(alive){setProvider(value);setProviderError('')} }).catch(e=>{if(alive){setProvider(null);setProviderError(e.message)}})
    return ()=>{alive=false}
  },[active])
  useEffect(()=>()=>{operation.current++},[])
  useEffect(() => {
    const preventLoss = (e: BeforeUnloadEvent) => { if (busy || saveError) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload',preventLoss); return ()=>window.removeEventListener('beforeunload',preventLoss)
  },[busy,saveError])
  const patch = (values: Partial<FsdDraft>, content = true) => setDraft(d=>({...d,...values,revision:content?d.revision+1:d.revision,reviewed:content?false:values.reviewed??d.reviewed}))
  const detail = (key: keyof FsdDetails,value: string) => patch({details:{...draft.details,[key]:value}})
  const stale = draft.previewRevision !== draft.revision
  const presets = [...FSD_PRESETS,...draft.customPresets]
  async function addFiles(files: File[]) {
    if (!files.length || busy) return
    if (draft.sources.length+files.length>20) {setError('Use up to 20 sources.');return}
    const id = ++operation.current; setError('');setBusy('Reading documents…')
    const added: FsdSource[] = [], errors: string[] = []
    for (const file of files) {
      try { const text = await readFsdSource(file,setBusy); added.push({id:sourceId([...draftRef.current.sources,...added]),name:file.name,kind:uploadKind,target:'',text}) }
      catch(e){ errors.push(e instanceof Error?e.message:'Document could not be read.') }
    }
    if (id !== operation.current) return
    setDraft(d=>({...d,sources:[...d.sources,...added],revision:d.revision+1,reviewed:false}))
    setError(errors.join('\n'));setBusy('')
  }
  async function generatePreview() {
    if (busy) return
    if (draft.pasteText.trim()) { setError('Add your pasted text to Sources before generating, so it is included.');return }
    const required: (keyof FsdDetails)[] = ['client','feature','product','date','version','author']
    if (required.some(k=>!draft.details[k].trim()) || !draft.sources.length) {setError('Complete the required document details and add at least one source.');return}
    const id=++operation.current,snapshot=draft,revision=draft.revision
    setBusy('Generating preview with your account’s AI…');setError('')
    try {
      const preview=await request<FsdPreview>('preview',snapshot)
      if (id!==operation.current) return
      setDraft(d=>({...d,preview,previewRevision:revision,reviewed:false}));setShowPreview(true);setEditPreview(false)
      setProvider(p=>({...p,enabled:true,name:preview.provider,model:preview.model}))
    } catch(e) {if(id===operation.current)setError(e instanceof Error?e.message:'Generation failed.')}
    finally {if(id===operation.current)setBusy('')}
  }
  async function exportFsd() {
    if (!templateReady || !draft.preview || stale || !draft.reviewed || busy) return
    const id = ++operation.current
    setBusy('Preparing Word document…');setError('')
    try {
      const result=await request<{fileData:string;fileName:string;mimeType:string}>('generate',{details:draft.details,preview:draft.preview,reviewed:true})
      if (id !== operation.current) return
      const bytes=Uint8Array.from(atob(result.fileData),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:result.mimeType}))
      const a=document.createElement('a');a.href=url;a.download=result.fileName;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
    } catch(e){setError(e instanceof Error?e.message:'Export failed.')}
    finally{setBusy('')}
  }
  function editBlock(sectionIndex:number,blockIndex:number,row:number,col:number,value:string) {
    setDraft(d=> {
      if(!d.preview)return d
      const preview=structuredClone(d.preview),block=preview.sections[sectionIndex].blocks[blockIndex]
      if(block.type==='paragraph') block.text=value
      else block.rows[row][col]=value
      return {...d,preview,reviewed:false}
    })
  }
  function addPaste() {
    if(!draft.pasteText.trim())return
    if(draft.sources.length>=20 || draft.pasteText.length>120000){setError('Use up to 20 sources, each up to 120,000 characters.');return}
    patch({sources:[...draft.sources,{id:sourceId(draft.sources),name:draft.pasteName.trim()||`${draft.pasteKind} ${draft.sources.length+1}`,kind:draft.pasteKind,target:'',text:draft.pasteText.trim()}],pasteText:'',pasteName:''})
  }
  const detailsField=(key:keyof FsdDetails,label:string,type='text',required=false)=><label key={key}>{label}{required?' *':''}<input type={type} maxLength={180} value={draft.details[key]} onChange={e=>detail(key,e.target.value)} required={required}/></label>
  return <div className="fsd-creator">
    <div className="fsd-topline"><div><span className="fsd-eyebrow">DOCUMENT CREATION</span><h2>FSD Document Creator</h2><p>Turn your requirements into a reviewable specification.</p></div><span className="fsd-template-badge"><FileText size={16}/>{templateReady ? FSD_TEMPLATE_NAME : 'Template required'}</span></div>
    <div className="fsd-mode-tabs" role="tablist" aria-label="FSD mode">{(['basic','advanced'] as const).map(mode=><button key={mode} role="tab" aria-selected={draft.mode===mode} className={draft.mode===mode?'active':''} disabled={Boolean(busy)} onClick={()=>patch({mode})}>{mode==='basic'?<FileText size={18}/>:<Layers size={18}/>}<span><strong>{mode==='basic'?'Basic Mode':'Advance Mode'}</strong><small>{mode==='basic'?'Upload · Preset · Preview · Generate':'Multiple sources · Mapping · Detailed controls'}</small></span></button>)}</div>
    <div className="fsd-status"><span>{provider?.enabled?`Document Agent: ${provider.name} · ${provider.model}`:providerError||'Configure and enable the Document Agent in Account Settings.'}</span><span>{saveError?'Draft held in this page':'Draft retained in this browser tab'}</span></div>
    {presetSaveError&&<p className="fsd-warning" role="status">{presetSaveError}</p>}
    {saveError&&<p className="fsd-warning" role="status">{saveError}</p>}
    <DocumentProcessingPanel state={error?'error':busy?'working':draft.preview?'success':'idle'} title={error?'FSD processing failed':busy||'FSD preview is ready'} detail={error||(!busy&&draft.preview?'Review the preview below, then generate the Word document.':'')} stages={busy.includes('Reading')?['Uploading documents','Reading and extracting content','Adding sources','Ready for mapping']:busy.includes('Word')?['Validating reviewed preview','Mapping information to template','Generating Word document','Starting download']:['Preparing source content','Mapping information to template','Generating preview','Ready for review']} activeStage={busy.includes('Reading')?1:busy.includes('Word')?2:2} onRetry={error&&draft.preview&&draft.reviewed&&!stale?()=>void exportFsd():error?()=>void generatePreview():undefined}/>
    <fieldset disabled={!canGenerate||Boolean(busy)} className="fsd-fieldset">
      <div className="fsd-columns">
        <div className="fsd-input-column">
          <section className="fsd-card"><h3>1. Document details</h3><div className="fsd-fields">
            <label>Client *<input list={`fsd-clients-${draftKey}`} value={draft.details.client} maxLength={180} onChange={e=>detail('client',e.target.value)}/><datalist id={`fsd-clients-${draftKey}`}>{clients.map(c=><option key={c.id} value={c.name}/>)}</datalist></label>
            {detailsField('feature','Feature name','text',true)}{detailsField('product','Product','text',true)}{detailsField('author','Prepared by','text',true)}{detailsField('date','Document date','date',true)}{detailsField('version','Revision','text',true)}
            <label className="fsd-full">Document reference<input value={draft.details.reference} maxLength={180} placeholder={fsdReference(draft.details)} onChange={e=>detail('reference',e.target.value)}/></label>
          </div><details><summary>Signatories</summary><p>Names remain editable. Signature and date lines stay blank for approval.</p><div className="fsd-fields">{detailsField('irippleBA','iRipple Business Analyst')}{detailsField('iripplePM','iRipple Project Manager')}{detailsField('clientName1','Client signatory 1')}{detailsField('clientTitle1','Position 1')}{detailsField('clientName2','Client signatory 2')}{detailsField('clientTitle2','Position 2')}</div></details></section>
          <section className="fsd-card"><h3>2. Requirements & supporting sources</h3><label>Upload as<select value={uploadKind} onChange={e=>setUploadKind(e.target.value as FsdSource['kind'])}>{['BRD','Meeting notes','Supporting document','Chat'].map(k=><option key={k}>{k}</option>)}</select></label>
            <label className="fsd-dropzone"><Plus size={26}/><strong>Add BRD or other documents</strong><span>PDF, DOCX, TXT, MD, CSV, JSON · 10 MB each</span><input type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.json" onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void addFiles(files)}}/></label>
            <small>Up to 20 sources / 180,000 characters total. PDF scans use English OCR. Review extracted text; diagrams and embedded images are not interpreted.</small>
            <div className="fsd-source-list">{draft.sources.map(source=><details key={source.id}><summary><FileText size={15}/><span>{source.name}</span><small>{source.kind} · {source.text.length.toLocaleString()} chars</small></summary><div className="fsd-source-actions"><label>Source type<select value={source.kind} onChange={e=>patch({sources:draft.sources.map(s=>s.id===source.id?{...s,kind:e.target.value as FsdSource['kind']}:s)})}>{['BRD','Meeting notes','Supporting document','Chat'].map(k=><option key={k}>{k}</option>)}</select></label>{draft.mode==='advanced'&&<label>Map primarily to<select value={source.target} onChange={e=>patch({sources:draft.sources.map(s=>s.id===source.id?{...s,target:e.target.value}:s)})}><option value="">AI determines applicable sections</option>{FSD_SECTIONS.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>}<button type="button" className="secondary" onClick={()=>patch({sources:draft.sources.filter(s=>s.id!==source.id)})}><Trash2 size={14}/>Remove</button></div><label>Review / correct extracted text<textarea rows={9} maxLength={120000} value={source.text} onChange={e=>patch({sources:draft.sources.map(s=>s.id===source.id?{...s,text:e.target.value}:s)})}/></label></details>)}</div>
            <details className="fsd-paste" open={draft.mode==='advanced'||Boolean(draft.pasteText)}><summary>Paste meeting notes, chat or requirements</summary><div className="fsd-fields"><label>Source name<input value={draft.pasteName} maxLength={200} placeholder="Client meeting — 21 Sep" onChange={e=>patch({pasteName:e.target.value},false)}/></label><label>Source type<select value={draft.pasteKind} onChange={e=>patch({pasteKind:e.target.value as FsdSource['kind']},false)}>{['BRD','Meeting notes','Supporting document','Chat'].map(k=><option key={k}>{k}</option>)}</select></label></div><textarea aria-label="Pasted requirements" placeholder="Paste the requirements here…" rows={6} maxLength={120000} value={draft.pasteText} onChange={e=>patch({pasteText:e.target.value},false)}/><button className="secondary" disabled={!draft.pasteText.trim()} onClick={addPaste}><Plus size={15}/>Add to sources</button></details>
          </section>
        </div>
        <div className="fsd-controls-column"><section className="fsd-card"><h3>3. Skills & presets</h3><label>Preset<select value={draft.presetId} onChange={e=>{const preset=presets.find(p=>p.id===e.target.value)!;patch({presetId:preset.id,presetInstructions:preset.instructions})}}>{presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Customize instructions<textarea rows={8} maxLength={8000} value={draft.presetInstructions} onChange={e=>patch({presetInstructions:e.target.value})}/></label><small>Presets guide every AI generation. The template structure and evidence rules stay in place.</small><div className="fsd-save-preset"><label>Save as a common preset<input maxLength={100} placeholder="Preset name" value={draft.presetName} onChange={e=>patch({presetName:e.target.value},false)}/></label><button className="secondary" disabled={!draft.presetName.trim()||!draft.presetInstructions.trim()||draft.customPresets.length>=30} onClick={()=>{const preset={id:crypto.randomUUID(),name:draft.presetName.trim(),instructions:draft.presetInstructions};patch({customPresets:[...draft.customPresets,preset],presetId:preset.id,presetName:''},false)}}>Save preset</button></div><small>Custom presets are saved for this account and user in this browser.</small>{draft.customPresets.some(p=>p.id===draft.presetId)&&<button className="secondary" onClick={()=>patch({customPresets:draft.customPresets.filter(p=>p.id!==draft.presetId),presetId:'standard',presetInstructions:FSD_PRESETS[0].instructions})}>Delete custom preset</button>}</section>
          {draft.mode==='advanced'&&<section className="fsd-card"><h3>4. Scope & section mapping</h3><p>Uncheck modules to exclude them. Basic Mode lets the AI determine applicability from the sources.</p><div className="fsd-module-checks">{FSD_MODULES.map(module=><label key={module}><input type="checkbox" checked={draft.modules.includes(module)} onChange={e=>patch({modules:e.target.checked?[...draft.modules,module]:draft.modules.filter(m=>m!==module)})}/>{module}</label>)}</div><label>Additional skills / guidance<textarea rows={5} maxLength={10000} value={draft.guidance} placeholder="Terminology, known constraints, priorities…" onChange={e=>patch({guidance:e.target.value})}/></label><details><summary>Map instructions to template sections</summary>{FSD_SECTIONS.filter(([id])=>!['history','acknowledgement','references'].includes(id)).map(([id,title])=><label key={id}>{title}<textarea rows={2} maxLength={2000} value={draft.mapping[id]||''} placeholder="Optional: sources to prioritize and details to cover" onChange={e=>patch({mapping:{...draft.mapping,[id]:e.target.value}})}/></label>)}</details></section>}
          <section className="fsd-card fsd-generate-card"><h3>{draft.mode==='basic'?'4':'5'}. Preview & generate</h3><p>The AI maps your sources into the iRipple template. Review and edit the result before downloading Word.</p><button className="primary fsd-primary" disabled={!draft.sources.length||!draft.presetInstructions.trim()} onClick={()=>void generatePreview()}><Sparkles size={16}/>{draft.preview?'Regenerate AI preview':'Generate AI preview'}</button>{draft.preview&&<button className="secondary" onClick={()=>setShowPreview(v=>!v)}>{showPreview?'Hide':'Show'} preview</button>}<small>Generation sends source text only to the Document Agent configured for this account.</small><details><summary>Template sections</summary><ol>{FSD_SECTIONS.map(([id,title])=><li key={id}>{title}</li>)}</ol></details></section>
        </div>
      </div>
    </fieldset>
    {showPreview&&draft.preview&&<section className="fsd-preview-panel"><div className="fsd-preview-toolbar"><div><h3>FSD Preview</h3><small>{draft.preview.provider} · {draft.preview.model} · {new Date(draft.preview.generatedAt).toLocaleString()}</small></div><button className="secondary" disabled={!canGenerate||Boolean(busy)||stale} onClick={()=>setEditPreview(v=>!v)}>{editPreview?'Finish editing':'Edit preview'}</button></div>
      {stale&&<p className="fsd-warning">Inputs changed after this preview. Regenerate before exporting.</p>}
      <div className="fsd-paper"><div className="fsd-paper-header"><strong>iRipple</strong><b>FEATURE SPECIFICATION DOCUMENT</b><small>Document Version:<br/>{fsdReference(draft.details)}</small></div><div className="fsd-cover"><h2>{draft.details.product}</h2><h2>{draft.details.feature}</h2><p>Agreed and Approved by:</p><div className="fsd-signatories"><div><b>IRIPPLE, INC.</b><p>{draft.details.irippleBA||'Name'} — Business Analyst</p><p>{draft.details.iripplePM||'Name'} — Project Manager</p></div><div><b>{draft.details.client}</b><p>{draft.details.clientName1||'Name'} — {draft.details.clientTitle1||'Position'}</p><p>{draft.details.clientName2||'Name'} — {draft.details.clientTitle2||'Position'}</p></div></div><small>Signature and date lines are left blank in the Word document.</small></div><details><summary>Proprietary Data Notice</summary><p className="fsd-preserve">{FSD_NOTICE}</p></details><details><summary>Table of Contents</summary>{FSD_SECTIONS.map(([id,title])=><p key={id}>{title}</p>)}</details>
      {draft.preview.sections.map((section,si)=><section className="fsd-preview-section" key={section.id}>{section.id==='summary'&&<h2>1. Introduction</h2>}{section.id==='mms'&&<h2>5. Software Features</h2>}{section.id==='assumptions'&&<h2>VI. Assumptions and Limitations</h2>}<h3>{section.title}</h3><small className="fsd-source-citation">{section.sourceIds.length?`Sources: ${section.sourceIds.map(id=>draft.sources.find(s=>s.id===id)?.name||id).join(', ')}`:'Document metadata / review item'}</small>{section.blocks.map((block,bi)=>block.type==='paragraph'?editPreview?<textarea key={bi} disabled={Boolean(busy)||!canGenerate||stale} aria-label={section.title} rows={Math.min(20,Math.max(3,block.text.split('\n').length+2))} maxLength={16000} value={block.text} onChange={e=>editBlock(si,bi,0,0,e.target.value)}/>:<p className="fsd-preserve" key={bi}>{block.text}</p>:<div className="fsd-table-scroll" key={bi}><table><thead><tr>{block.headers.map((header,hi)=><th key={hi}>{header}</th>)}</tr></thead><tbody>{block.rows.map((row,ri)=><tr key={ri}>{row.map((cell,ci)=><td key={ci}>{editPreview?<textarea disabled={Boolean(busy)||!canGenerate||stale} aria-label={`${section.title}, ${block.headers[ci]}, row ${ri+1}`} rows={3} maxLength={8000} value={cell} onChange={e=>editBlock(si,bi,ri,ci,e.target.value)}/>:<span className="fsd-preserve">{cell}</span>}</td>)}</tr>)}</tbody></table></div>)}</section>)}
      {(draft.preview.gaps.length>0||draft.preview.conflicts.length>0)&&<section className="fsd-review-items"><h3>Review Items — Pending Confirmation</h3>{draft.preview.gaps.length>0&&<><h4>Missing information</h4><ul>{draft.preview.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></>}{draft.preview.conflicts.length>0&&<><h4>Conflicting sources</h4><ul>{draft.preview.conflicts.map((g,i)=><li key={i}>{g}</li>)}</ul></>}</section>}</div>
      <div className="fsd-export"><label><input type="checkbox" checked={draft.reviewed} disabled={stale||Boolean(busy)||!canGenerate} onChange={e=>patch({reviewed:e.target.checked},false)}/>I reviewed this preview and any pending confirmations. This does not record client approval.</label><button className="primary" disabled={stale||!draft.reviewed||Boolean(busy)||!canGenerate||!templateReady} onClick={()=>void exportFsd()}><Download size={16}/>Generate & Download FSD (.docx)</button><small>{templateReady ? 'Word export follows the template selected in Settings → Templates. Update the table of contents in Word for final page numbers.' : 'An Administrator must configure or restore the FSD template in Settings → Templates before export.'}</small></div>
    </section>}
    <div className="fsd-draft-footer"><small>Your entries remain when switching modes or modules. Refresh restores the saved draft in this tab.</small>{clearConfirm?<span>Clear this draft?<button className="secondary" disabled={Boolean(busy)||!canGenerate} onClick={()=>{operation.current++;const next=emptyFsdDraft();next.customPresets=draftRef.current.customPresets;setDraft(next);setShowPreview(false);setError('');setClearConfirm(false)}}>Clear draft</button><button className="secondary" onClick={()=>setClearConfirm(false)}>Cancel</button></span>:<button className="secondary" disabled={Boolean(busy)||!canGenerate} onClick={()=>setClearConfirm(true)}>Start new FSD</button>}</div>
  </div>
}
