import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Plus, Send, Sparkles, Trash2 } from 'lucide-react'
import DocumentReset from './DocumentReset'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import { useDocumentOperation } from './useDocumentOperation'
import { isFsdImageFile, readFsdSource } from './fsd-sources'
import type { Project } from '../../shared/types'
import { APP_VERSION } from '../../shared/version'
import { documentOutputName, suggestedDocumentStem } from './documentFilename'
import { announceGeneratedDocument } from './documentDrive'
import {
  BRD_TEMPLATE_NAME, brdHandoffText, brdReference, emptyBrdDraft,
  type BrdDraft, type BrdDetails, type BrdMappingRow, type BrdPreview,
  type BrdRequirement, type BrdSource, type BrdStakeholder,
} from './brd-model'
import './fsd.css'
import './brd.css'
import { requestJson } from '../../shared/http'

type Provider = { enabled: boolean; provider?: string; name?: string; model?: string }
function sourceId(sources: BrdSource[]) { return `SRC-${String(Math.max(0,...sources.map(s=>Number(s.id.replace(/^SRC-/,''))||0))+1).padStart(3,'0')}` }
const request = <T,>(path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson<T>(`/api/documents/brd/${path}`, { body: body || undefined, signal, fallback: 'The BRD request failed. Your draft is retained.' })
function downloadBase64(base64: string, mimeType: string, filename: string) {
  const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:mimeType}))
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
export default function BrdCreation({ projects, canGenerate, templateReady, draftKey, active, onUseInFsd }: {
  projects: Project[]; canGenerate: boolean; templateReady: boolean; draftKey: string; active: boolean;
  onUseInFsd: (handoff: { name: string; text: string; reference: string }) => void
}) {
  const storageKey=`ba-brd-v1:${draftKey}`
  const [draft,setDraft]=useState<BrdDraft>(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const saved=JSON.parse(raw);if(saved?.details&&Array.isArray(saved?.sources))return {...emptyBrdDraft(),...saved}}}catch{}return emptyBrdDraft()})
  const [provider,setProvider]=useState<Provider|null>(null),[providerError,setProviderError]=useState('')
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[saveError,setSaveError]=useState('')
  const [showPreview,setShowPreview]=useState(Boolean(draft.preview)),[editPreview,setEditPreview]=useState(false)
  const [uploadKind,setUploadKind]=useState<BrdSource['kind']>('Requirements')
  const [stage,setStage]=useState<'reading'|'preview'|'export'>('reading')
  const operation=useDocumentOperation(), fileInput=useRef<HTMLInputElement>(null), draftRef=useRef(draft);draftRef.current=draft
  useEffect(()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setSaveError('')}catch{setSaveError('Browser storage is unavailable or full. Your BRD draft is retained only while this page stays open.')}},[draft,storageKey])
  useEffect(()=>{if(!active)return;let alive=true;request<Provider>('provider').then(v=>{if(alive){setProvider(v);setProviderError('')}}).catch(e=>{if(alive){setProvider(null);setProviderError(e.message)}});return()=>{alive=false}},[active])
  const patch=(values:Partial<BrdDraft>,content=true)=>setDraft(d=>({...d,...values,revision:content?d.revision+1:d.revision,reviewed:content?false:values.reviewed??d.reviewed}))
  const detail=(key:keyof BrdDetails,value:string)=>patch({details:{...draft.details,[key]:value}})
  const suggestedFileName=suggestedDocumentStem('BRD','',draft.details.projectName)
  const fileName=draft.fileNameOverride ?? suggestedFileName
  const stale=draft.previewRevision!==draft.revision
  async function addFiles(files:File[]){
    if(!files.length||busy)return
    if(draft.sources.length+files.length>20){setError('Use up to 20 sources.');return}
    const job=operation.begin();setStage('reading');setBusy('Reading requirement sources…');setError('')
    const added:BrdSource[]=[],errors:string[]=[]
    for(const file of files){if(!job.isCurrent())return;try{const text=await readFsdSource(file,m=>{if(job.isCurrent())setBusy(m)});if(!job.isCurrent())return;const total=[...draftRef.current.sources,...added].reduce((s,x)=>s+x.text.length,0)+text.length;if(total>180000)throw new Error(`${file.name}: sources would exceed 180,000 characters.`);added.push({id:sourceId([...draftRef.current.sources,...added]),name:file.name,kind:isFsdImageFile(file)?'Supporting document':uploadKind,text})}catch(e){errors.push(e instanceof Error?e.message:`Could not read ${file.name}.`)}}
    if(!job.isCurrent())return
    if(added.length)patch({sources:[...draftRef.current.sources,...added],preview:null,previewRevision:-1})
    setError(errors.join('\n'));setBusy('')
  }
  function addPaste(){
    const text=draft.pasteText.trim();if(!text||busy)return
    if(draft.sources.length>=20||text.length>120000){setError('Use up to 20 sources and 120,000 characters per source.');return}
    if(draft.sources.reduce((s,x)=>s+x.text.length,0)+text.length>180000){setError('Sources exceed 180,000 characters. Split the requirements into smaller documents.');return}
    patch({sources:[...draft.sources,{id:sourceId(draft.sources),name:draft.pasteName.trim()||`${draft.pasteKind} ${draft.sources.length+1}`,kind:draft.pasteKind,text}],pasteName:'',pasteText:'',preview:null,previewRevision:-1})
  }
  async function generatePreview(){
    if(busy||!draft.sources.length)return
    const job=operation.begin(),revision=draft.revision;setStage('preview');setBusy('Drafting BRD from available information…');setError('')
    try{const preview=await request<BrdPreview>('preview',{details:draft.details,sources:draft.sources,guidance:draft.guidance},job.signal);if(!job.isCurrent())return;setDraft(d=>({...d,preview,previewRevision:revision,reviewed:false}));setProvider(p=>({...p,enabled:true,name:preview.provider,model:preview.model}));setShowPreview(true);setEditPreview(false)}catch(e){if(job.isCurrent())setError(e instanceof Error?e.message:'BRD generation failed.')}finally{if(job.isCurrent())setBusy('')}
  }
  async function exportBrd(){
    if(!draft.preview||stale||!draft.reviewed||!templateReady||busy)return
    const job=operation.begin();setStage('export');setBusy('Mapping reviewed BRD content to your template…');setError('')
    try{const result=await request<{fileData:string;fileName:string;mimeType:string}>('generate',{details:draft.details,preview:draft.preview,reviewed:true,fileName:documentOutputName(fileName,'docx',suggestedFileName)},job.signal);if(!job.isCurrent())return;downloadBase64(result.fileData,result.mimeType,result.fileName);announceGeneratedDocument('brd',result)}catch(e){if(job.isCurrent())setError(e instanceof Error?e.message:'BRD export failed.')}finally{if(job.isCurrent())setBusy('')}
  }
  function reset(){operation.cancel();const next=emptyBrdDraft();try{sessionStorage.removeItem(storageKey)}catch{}if(fileInput.current)fileInput.current.value='';setDraft(next);setShowPreview(false);setEditPreview(false);setError('');setBusy('');setSaveError('');setUploadKind('Requirements');setStage('reading')}
  const setPreview=(preview:BrdPreview)=>setDraft(d=>({...d,preview,reviewed:false}))
  const updateList=(key:'businessObjectives'|'businessProblems'|'inScope',index:number,value:string)=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next[key][index]=value;setPreview(next)}
  const addList=(key:'businessObjectives'|'businessProblems'|'inScope')=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next[key].push('');setPreview(next)}
  const removeList=(key:'businessObjectives'|'businessProblems'|'inScope',index:number)=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next[key].splice(index,1);setPreview(next)}
  const updateStakeholder=(i:number,values:Partial<BrdStakeholder>)=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next.stakeholders[i]={...next.stakeholders[i],...values};setPreview(next)}
  const updateRequirement=(i:number,values:Partial<BrdRequirement>)=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next.functionalRequirements[i]={...next.functionalRequirements[i],...values};setPreview(next)}
  const updateMapping=(i:number,values:Partial<BrdMappingRow>)=>{if(!draft.preview)return;const next=structuredClone(draft.preview);next.customerMapping[i]={...next.customerMapping[i],...values};setPreview(next)}
  return <div className="fsd-creator brd-creator">
    <div className="fsd-topline"><div><span className="fsd-eyebrow">DOCUMENT CREATION · BUSINESS REQUIREMENTS</span><h2>BRD Creator</h2><p>Turn incomplete notes and requirement sources into a structured, editable BRD that can feed FSD Creation.</p></div><span className="fsd-template-badge"><FileText size={16}/>{templateReady?BRD_TEMPLATE_NAME:'Template required'}</span></div>
    <DocumentReset label="BRD" onReset={reset} disabled={!canGenerate}/>
    <div className="fsd-status"><span>{provider?.enabled?`Document Agent: ${provider.name} · ${provider.model}`:providerError||'Configure and enable the Document Agent in Account Settings.'}</span><span>{saveError?'Draft held in this page':'Draft retained in this browser tab'} · App v{APP_VERSION}</span></div>
    {saveError&&<p className="fsd-warning">{saveError}</p>}
    <DocumentProcessingPanel state={error?'error':busy?'working':draft.preview?'success':'idle'} title={error?'BRD processing failed':busy?'Preparing your BRD…':draft.preview?'BRD preview is ready':'Add any available requirement information'} detail={error||(!busy?(draft.preview?'Review and edit the draft before exporting or sending it to FSD Creation.':'Incomplete input is allowed. The Document Agent creates a best-effort business draft and flags inferred items for confirmation.'):stage==='reading'?'Reading source content':stage==='export'?'Filling the iRipple BRD template':'Interpreting requirements and drafting business content')} stages={stage==='reading'?['Read source files','Collect source text','Ready for BRD drafting']:stage==='export'?['Validate reviewed preview','Map content to BRD template','Generate Word document','Start download']:['Interpret available facts','Draft missing business context','Structure requirements and acceptance criteria','Ready for review']} activeStage={busy?(stage==='reading'?1:stage==='export'?2:1):3} onRetry={error?()=>void generatePreview():undefined}/>
    <fieldset disabled={!canGenerate||Boolean(busy)} className="fsd-fieldset"><div className="fsd-columns"><div className="fsd-input-column">
      <section className="fsd-card"><h3>1. Document details</h3><div className="fsd-fields">
        <label>Project Name<input list={`brd-projects-${draftKey}`} value={draft.details.projectName} maxLength={180} placeholder="Optional — AI can draft without it" onChange={e=>detail('projectName',e.target.value)}/><datalist id={`brd-projects-${draftKey}`}>{projects.map(p=><option key={p.id} value={p.name}/>)}</datalist></label>
        <label>Module<input value={draft.details.module} maxLength={180} placeholder="e.g. Inventory, POS Registration" onChange={e=>detail('module',e.target.value)}/></label>
        <label>Date<input type="date" value={draft.details.date} onChange={e=>detail('date',e.target.value)}/></label><label>Prepared By<input value={draft.details.preparedBy} maxLength={180} onChange={e=>detail('preparedBy',e.target.value)}/></label>
        <label>Version<input value={draft.details.version} maxLength={40} onChange={e=>detail('version',e.target.value)}/></label><label>Document Reference<input value={draft.details.reference} maxLength={180} placeholder={brdReference(draft.details)} onChange={e=>detail('reference',e.target.value)}/></label>
        <label className="fsd-full">Filename (without .docx)<input aria-label="BRD filename" value={fileName} maxLength={150} onChange={e=>patch({fileNameOverride:e.target.value},false)} onBlur={()=>{if(!draft.fileNameOverride?.trim())patch({fileNameOverride:undefined},false)}}/><small>Download: {documentOutputName(fileName,'docx',suggestedFileName)}</small></label>
      </div><small>Only source content is required to start. Missing metadata can stay blank and is rendered as a neutral placeholder.</small></section>
      <section className="fsd-card"><h3>2. Requirement sources</h3><label>Upload as<select value={uploadKind} onChange={e=>setUploadKind(e.target.value as BrdSource['kind'])}>{['Requirements','Meeting notes','Supporting document','Chat'].map(k=><option key={k}>{k}</option>)}</select></label>
        <label className="fsd-dropzone"><Plus size={26}/><strong>Add requirements, meeting notes, screenshots or supporting documents</strong><span>PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, WEBP, BMP, TIF/TIFF · 10 MB each</span><input ref={fileInput} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff" onChange={e=>{const files=Array.from(e.target.files||[]) as File[];e.target.value='';void addFiles(files)}}/></label>
        <div className="brd-source-list">{draft.sources.map(source=><div className="document-file-row" key={source.id}><FileText size={16}/><div><strong>{source.name}</strong><span>{source.kind} · {source.text.length.toLocaleString()} characters</span></div><button type="button" className="secondary compact" onClick={()=>patch({sources:draft.sources.filter(s=>s.id!==source.id),preview:null,previewRevision:-1})}><Trash2 size={15}/>Remove</button></div>)}</div>
        <details className="fsd-paste" open><summary>Paste requirement notes, chat or meeting content</summary><div className="fsd-fields"><label>Source name<input value={draft.pasteName} maxLength={200} placeholder="Client meeting — inventory rules" onChange={e=>patch({pasteName:e.target.value},false)}/></label><label>Source type<select value={draft.pasteKind} onChange={e=>patch({pasteKind:e.target.value as BrdSource['kind']},false)}>{['Requirements','Meeting notes','Supporting document','Chat'].map(k=><option key={k}>{k}</option>)}</select></label></div><textarea rows={7} maxLength={120000} value={draft.pasteText} placeholder="Paste whatever information is available. It does not need to be a complete BRD." onChange={e=>patch({pasteText:e.target.value},false)}/><button className="secondary" disabled={!draft.pasteText.trim()} onClick={addPaste}><Plus size={15}/>Add to sources</button></details>
      </section>
    </div><div className="fsd-controls-column">
      <section className="fsd-card"><h3>3. Drafting guidance</h3><p>The BRD Agent writes business-level content first. It may infer reasonable wording from incomplete sources, but it must not invent named people, contracts, exact integrations, amounts, policies or approvals.</p><label>Additional guidance<textarea rows={8} maxLength={10000} value={draft.guidance} placeholder="Terminology, business context, priorities, rules to emphasize…" onChange={e=>patch({guidance:e.target.value})}/></label><small>Inferred items are marked in the preview and placed in open questions for confirmation, while the document still receives useful draft content.</small></section>
      <section className="fsd-card fsd-generate-card"><h3>4. Generate BRD preview</h3>{!draft.sources.length&&<div className="fsd-preview-prerequisites"><strong>Add at least one source.</strong><p>It can be incomplete; the BRD Creator will still produce a draft.</p></div>}<button className="primary fsd-primary" disabled={!draft.sources.length} onClick={()=>void generatePreview()}><Sparkles size={16}/>{draft.preview?'Regenerate BRD preview':'Generate BRD preview'}</button>{draft.preview&&<button className="secondary" onClick={()=>setShowPreview(v=>!v)}>{showPreview?'Hide':'Show'} preview</button>}<small>AI generation uses the account's Document Agent and only the sources shown here plus your optional guidance.</small></section>
    </div></div></fieldset>
    {showPreview&&draft.preview&&<section className="fsd-preview-panel brd-preview-panel"><div className="fsd-preview-toolbar"><div><h3>BRD Preview</h3><small>{draft.preview.provider} · {draft.preview.model} · {new Date(draft.preview.generatedAt).toLocaleString()}</small></div><button className="secondary" disabled={stale||Boolean(busy)} onClick={()=>setEditPreview(v=>!v)}>{editPreview?'Finish editing':'Edit preview'}</button></div>{stale&&<p className="fsd-warning">Inputs changed after this preview. Regenerate before exporting or sending it to FSD Creation.</p>}
      <div className="brd-paper"><header><h2>BUSINESS REQUIREMENTS DOCUMENT</h2><p>{brdReference(draft.details)}</p></header><div className="brd-meta"><b>Project Name:</b><span>{draft.details.projectName||'TBD Project'}</span><b>Module:</b><span>{draft.details.module||'TBD Module'}</span><b>Date:</b><span>{draft.details.date}</span><b>Prepared By:</b><span>{draft.details.preparedBy||'TBD'}</span><b>Version:</b><span>{draft.details.version||'1.0'}</span></div>
      <section><h3>A. INTRODUCTION</h3><h4>SUMMARY</h4>{editPreview?<textarea rows={5} value={draft.preview.summary} onChange={e=>setPreview({...draft.preview!,summary:e.target.value})}/>:<p className="fsd-preserve">{draft.preview.summary}</p>}</section>
      {([['businessObjectives','B. BUSINESS OBJECTIVES'],['businessProblems','C. BUSINESS PROBLEM'],['inScope','D. PROJECT SCOPE — IN-SCOPE']] as const).map(([key,title])=><section key={key}><h3>{title}</h3>{draft.preview![key].map((value,i)=><div className="brd-list-row" key={i}>{editPreview?<><input value={value} onChange={e=>updateList(key,i,e.target.value)}/><button className="icon-button danger" onClick={()=>removeList(key,i)}><Trash2 size={14}/></button></>:<p>• {value}</p>}</div>)}{editPreview&&<button className="secondary compact" onClick={()=>addList(key)}><Plus size={14}/>Add item</button>}</section>)}
      <section><h3>E. STAKEHOLDERS</h3><div className="fsd-table-scroll"><table><thead><tr><th>Stakeholder</th><th>Responsibility</th><th>Basis</th></tr></thead><tbody>{draft.preview.stakeholders.map((row,i)=><tr key={i}><td>{editPreview?<input value={row.stakeholder} onChange={e=>updateStakeholder(i,{stakeholder:e.target.value})}/>:row.stakeholder}</td><td>{editPreview?<textarea rows={2} value={row.responsibility} onChange={e=>updateStakeholder(i,{responsibility:e.target.value})}/>:row.responsibility}</td><td>{row.inferred?'Draft inference':'Source-supported'}{editPreview&&<button className="icon-button danger" onClick={()=>{const next=structuredClone(draft.preview!);next.stakeholders.splice(i,1);setPreview(next)}}><Trash2 size={13}/></button>}</td></tr>)}</tbody></table></div>{editPreview&&<button className="secondary compact" onClick={()=>{const next=structuredClone(draft.preview!);next.stakeholders.push({stakeholder:'',responsibility:'',sourceIds:[],inferred:true});setPreview(next)}}><Plus size={14}/>Add stakeholder</button>}</section>
      <section><h3>D. FUNCTIONAL REQUIREMENTS</h3><div className="fsd-table-scroll"><table><thead><tr><th>ID</th><th>Requirement</th><th>Description</th><th>Acceptance Criteria</th><th>Basis</th></tr></thead><tbody>{draft.preview.functionalRequirements.map((row,i)=><tr key={row.id||i}><td>{editPreview?<input value={row.id} onChange={e=>updateRequirement(i,{id:e.target.value})}/>:row.id}</td><td>{editPreview?<input value={row.requirement} onChange={e=>updateRequirement(i,{requirement:e.target.value})}/>:row.requirement}</td><td>{editPreview?<textarea rows={4} value={row.description} onChange={e=>updateRequirement(i,{description:e.target.value})}/>:row.description}</td><td>{editPreview?<textarea rows={5} value={row.acceptanceCriteria.join('\n')} onChange={e=>updateRequirement(i,{acceptanceCriteria:e.target.value.split('\n').map(v=>v.trim()).filter(Boolean)})}/>:<ul>{row.acceptanceCriteria.map((a,j)=><li key={j}>{a}</li>)}</ul>}</td><td>{row.inferred?'Draft inference':'Source-supported'}{editPreview&&<button className="icon-button danger" onClick={()=>{const next=structuredClone(draft.preview!);next.functionalRequirements.splice(i,1);setPreview(next)}}><Trash2 size={13}/></button>}</td></tr>)}</tbody></table></div>{editPreview&&<button className="secondary compact" onClick={()=>{const next=structuredClone(draft.preview!);next.functionalRequirements.push({id:`BR-${String(next.functionalRequirements.length+1).padStart(3,'0')}`,requirement:'',description:'',acceptanceCriteria:[],sourceIds:[],inferred:true});setPreview(next)}}><Plus size={14}/>Add requirement</button>}</section>
      <section><h3>F. MAPPING — Customer Mapping</h3><div className="fsd-table-scroll"><table><thead><tr><th>Source</th><th>Source Field</th><th>Target</th><th>Target Field</th><th>Rule / Remarks</th></tr></thead><tbody>{draft.preview.customerMapping.map((row,i)=><tr key={i}>{(['source','sourceField','target','targetField','rule'] as const).map(key=><td key={key}>{editPreview?<textarea rows={2} value={row[key]} onChange={e=>updateMapping(i,{[key]:e.target.value})}/>:row[key]}</td>)}{editPreview&&<td className="brd-inline-action"><button className="icon-button danger" onClick={()=>{const next=structuredClone(draft.preview!);next.customerMapping.splice(i,1);setPreview(next)}}><Trash2 size={13}/></button></td>}</tr>)}</tbody></table></div>{editPreview&&<button className="secondary compact" onClick={()=>{const next=structuredClone(draft.preview!);next.customerMapping.push({source:'',sourceField:'',target:'',targetField:'',rule:'',sourceIds:[],inferred:true});setPreview(next)}}><Plus size={14}/>Add mapping</button>}</section>
      {draft.preview.openQuestions.length>0&&<section className="fsd-review-items"><h3>Open items for confirmation</h3><ul>{draft.preview.openQuestions.map((q,i)=><li key={i}>{q}</li>)}</ul></section>}</div>
      <div className="fsd-export brd-export"><label><input type="checkbox" checked={draft.reviewed} disabled={stale||Boolean(busy)} onChange={e=>patch({reviewed:e.target.checked},false)}/>I reviewed the BRD draft and inferred items.</label><div className="brd-export-actions"><button className="secondary" disabled={stale||!draft.reviewed||Boolean(busy)} onClick={()=>onUseInFsd({name:`${brdReference(draft.details)}.json`,reference:brdReference(draft.details),text:brdHandoffText(draft.details,draft.preview!)} )}><Send size={16}/>Use in FSD Creator</button><button className="primary" disabled={stale||!draft.reviewed||Boolean(busy)||!templateReady} onClick={()=>void exportBrd()}><Download size={16}/>Generate & Download BRD (.docx)</button></div><small>{templateReady?'The Word export uses the BRD template mapped from your supplied iRipple document.':'Restore or configure the BRD template in Settings → Templates before export.'}</small></div>
    </section>}
  </div>
}
