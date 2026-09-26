import { useEffect, useId, useRef, useState } from 'react'
import { Archive, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FileSignature, FolderOpen, LayoutGrid, List, RefreshCw, UserRound, X } from 'lucide-react'
import type { Client, Project, WorkItem } from './types'
import { dochubRequest, docHubGuidance, docHubLabels, isArchivedDocHubStatus, validateSigners, type DocHubDocument, type DocHubSigner, type GeneratedDocument } from './dochub'
import './dochub.css'

const updated=()=>window.dispatchEvent(new Event('dochub-updated'))
const dateTime=(value?:string)=>value?new Date(value).toLocaleString():'Pending'

export function useDocHubDraft(kind:'DRF'|'Sign-Off') {
  const [available,setAvailable]=useState(false),[enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [doc,setDoc]=useState<DocHubDocument|null>(null)
  const [options,setOptions]=useState({clientId:'',taskId:'',sequential:false,followUpDays:3})
  const pending=useRef<any>(null)
  useEffect(()=>{let alive=true;const load=()=>{void dochubRequest('/api/dochub/status').then(s=>{if(alive){setAvailable(s.enabled);setEnabled(s.enabled);setError('')}}).catch(e=>{if(alive)setError(e.message)})};load();window.addEventListener('dochub-settings-changed',load);return()=>{alive=false;window.removeEventListener('dochub-settings-changed',load)}},[])
  const submit=async(input:any)=>{setBusy(true);setError('');try{const result=await dochubRequest('/api/dochub/prepare','POST',input);setDoc(result.document);updated()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  const prepare=async(file:GeneratedDocument,signers:DocHubSigner[])=>{if(!enabled)return;validateSigners(signers);setDoc(null);const input={...file,...options,kind,id:crypto.randomUUID(),signers};pending.current=input;await submit(input)}
  const refresh=async()=>{if(!doc||busy)return;setBusy(true);setError('');try{const r=await dochubRequest(`/api/dochub/documents/${doc.id}/refresh`,'POST');setDoc(r.document);updated()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  useEffect(()=>{if(!doc||!['IMPORTING','UPLOADING','UPLOADED'].includes(doc.status))return;const timer=window.setTimeout(()=>void refresh(),5000);return()=>window.clearTimeout(timer)},[doc,busy])
  return {available,enabled,setEnabled,busy,error,canRetry:Boolean(pending.current),doc,options,setOptions,prepare,refresh,retry:()=>pending.current?submit(pending.current):Promise.resolve(),validate:(signers:DocHubSigner[])=>{if(enabled)validateSigners(signers)}}
}

type Draft=ReturnType<typeof useDocHubDraft>
export function DocHubOptions({draft,clients,projects,items,disabled=false}:{draft:Draft;clients:Client[];projects:Project[];items:WorkItem[];disabled?:boolean}) {
  const [projectId,setProjectId]=useState('')
  const selected=items.find(i=>i.id===draft.options.taskId)
  useEffect(()=>{if(selected?.projectId)setProjectId(selected.projectId)},[draft.options.taskId])
  const allowed=items.filter(i=>(!draft.options.clientId||i.clientId===draft.options.clientId)&&(!projectId||i.projectId===projectId)&&!clients.find(c=>c.id===i.clientId)?.archived&&!projects.find(p=>p.id===i.projectId)?.archived)
  return <section className="document-extraction-panel dochub-options"><h3><FileSignature size={18}/> DocHub signature preparation</h3><p>Signer emails are used for signing only and stay off the generated form.</p>
    <label className="dochub-check"><input type="checkbox" checked={draft.enabled} disabled={disabled||!draft.available||draft.busy} onChange={e=>draft.setEnabled(e.target.checked)}/> Prepare an unsent DocHub draft after generation</label>
    {!draft.available&&<p>Ask your account Administrator to add and enable the DocHub API key in Settings.</p>}
    {draft.enabled&&<div className="document-field-grid"><label>Link to client<select disabled={disabled||draft.busy} value={draft.options.clientId} onChange={e=>draft.setOptions(o=>({...o,clientId:e.target.value,taskId:''}))}><option value="">No client selected</option>{clients.filter(c=>!c.archived).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>Filter by project<select disabled={disabled||draft.busy} value={projectId} onChange={e=>{setProjectId(e.target.value);draft.setOptions(o=>({...o,taskId:''}))}}><option value="">All projects</option>{projects.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label className="document-field-wide">Existing task or subtask<select disabled={disabled||draft.busy} value={draft.options.taskId} onChange={e=>{const task=items.find(i=>i.id===e.target.value);draft.setOptions(o=>({...o,taskId:e.target.value,clientId:task?.clientId||o.clientId}))}}><option value="">No task association</option>{allowed.map(i=><option key={i.id} value={i.id}>{i.parentTaskId?`${items.find(t=>t.id===i.parentTaskId)?.title || 'Task'} → `:''}{i.title}{!draft.options.clientId?` · ${clients.find(c=>c.id===i.clientId)?.name || 'No client'}`:''}</option>)}</select><small>{selected?'Updates will appear in this work item’s comments.':'Choose the existing work item to keep signing updates in one place.'}</small></label>
    <label>Signing order<select disabled={disabled||draft.busy} value={draft.options.sequential?'yes':'no'} onChange={e=>draft.setOptions(o=>({...o,sequential:e.target.value==='yes'}))}><option value="no">All at once</option><option value="yes">Sequential · form order</option></select></label>
    <label>Follow up after sending<select disabled={disabled||draft.busy} value={draft.options.followUpDays} onChange={e=>draft.setOptions(o=>({...o,followUpDays:Number(e.target.value)}))}>{[0,1,3,5,7,14,30].map(n=><option key={n} value={n}>{n?`${n} days`:'No automatic follow-up'}</option>)}</select><small>Sets the linked work item’s follow-up if it has no date. Existing dates are kept.</small></label></div>}
    {draft.enabled&&<p className="dochub-note">You will place and assign signature fields in DocHub, then review and send there. Generation does not send invitations.</p>}
  </section>
}

export function DocHubResult({draft}:{draft:Draft}) {return <div className="dochub-result" aria-live="polite">{draft.busy&&<p className="dochub-progress"><RefreshCw size={16} className="dochub-spin"/> Preparing DocHub document…</p>}{draft.error&&<div role="alert"><p>{draft.error}</p>{draft.canRetry&&<button type="button" className="secondary" disabled={draft.busy} onClick={()=>void draft.retry()}>Retry same preparation</button>}</div>}{draft.doc&&<DocHubCard doc={draft.doc} refresh={draft.refresh} busy={draft.busy}/>}</div>}

function DocHubCard({doc,refresh,busy=false}:{doc:DocHubDocument;refresh:()=>Promise<void>;busy?:boolean}) {
  const [recoverId,setRecoverId]=useState(''),[recoverError,setRecoverError]=useState(''),[recoverBusy,setRecoverBusy]=useState(false)
  const signers=doc.signers.filter(s=>!s.removed),signed=signers.filter(s=>s.signedAt||s.status==='FINALIZED').length
  const guidance=docHubGuidance(doc)
  return <article className={`dochub-card${doc.status==='COMPLETED'?' complete':''}`}><div className="dochub-card-head"><div><strong>{doc.title}</strong><span>{docHubLabels[doc.status] || doc.status}</span></div><span className="count-pill">{signed}/{signers.length} signed</span></div>
    {doc.createdByName&&<div className="dochub-created-by"><UserRound size={14}/><span>Created by <strong>{doc.createdByName}</strong> · {dateTime(doc.createdAt)}</span></div>}
    {doc.error&&<p className="dochub-error" role="alert">{doc.error}</p>}{guidance&&<p className="dochub-guidance">{guidance}</p>}
    <div className="dochub-actions">{doc.documentUrl&&<a className="secondary" href={doc.documentUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/> Open in DocHub</a>}<button type="button" className="secondary" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={15}/>{busy?'Refreshing…':'Refresh status'}</button>{doc.status==='COMPLETED'&&<a className="secondary" href={`/api/dochub/documents/${doc.id}/pdf`} target="_blank" rel="noopener noreferrer">View signed PDF</a>}</div>
    <small>Last checked: {dateTime(doc.checkedAt)}{doc.followUpDate?` · Follow-up: ${doc.followUpDate}`:''}</small>
    <details><summary>Signatories and activity</summary><ul className="dochub-signers">{signers.map((s,i)=><li key={s.id||i}><strong>{s.name}</strong><span>{s.email}</span><span>{s.signedAt||s.status==='FINALIZED'?'Signed':s.viewedAt?'Viewed':s.status || 'Prepared'}{s.signedAt?` · ${dateTime(s.signedAt)}`:''}</span></li>)}</ul><ol className="dochub-timeline">{doc.events.map(e=><li key={e.id}><time>{dateTime(e.createdAt)}</time>{e.message}</li>)}</ol></details>
    {doc.status==='REVIEW_REQUIRED'&&!doc.documentId&&<div><p>After confirming the matching file in DocHub, enter its document ID to resume this preparation.</p><input aria-label="Existing DocHub document ID" value={recoverId} onChange={e=>setRecoverId(e.target.value)}/><button type="button" className="secondary" disabled={!recoverId||recoverBusy} onClick={async()=>{setRecoverBusy(true);try{await dochubRequest(`/api/dochub/documents/${doc.id}/recover`,'POST',{documentId:recoverId});await refresh()}catch(e){setRecoverError((e as Error).message)}finally{setRecoverBusy(false)}}}>Link existing document</button>{recoverError&&<p role="alert">{recoverError}</p>}</div>}
  </article>
}

function DocHubTile({doc,busy,onRefresh,onOpen,archived}:{doc:DocHubDocument;busy:boolean;onRefresh:()=>Promise<void>;onOpen:()=>void;archived:boolean}) {
  const signers=doc.signers.filter(s=>!s.removed),signed=signers.filter(s=>s.signedAt||s.status==='FINALIZED').length
  return <article className={`dochub-tile${archived?' archived':''}`}>
    <div className="dochub-tile-head"><div><span className="dochub-kind">{doc.kind}</span><strong title={doc.title}>{doc.title}</strong></div><span className={`dochub-status${archived?' archived':''}`}>{docHubLabels[doc.status] || doc.status}</span></div>
    <div className="dochub-tile-facts">
      <span><UserRound size={13}/><b>{doc.createdByName || 'Unknown user'}</b></span>
      <span>Created {dateTime(doc.createdAt)}</span>
      <span>Signatures <b>{signed}/{signers.length}</b></span>
      {doc.followUpDate&&<span>Follow-up <b>{doc.followUpDate}</b></span>}
    </div>
    <div className="dochub-tile-actions"><button type="button" className="secondary compact" onClick={onOpen}>Details</button>{doc.documentUrl&&<a className="secondary compact" href={doc.documentUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/> Open</a>}{!archived&&<button type="button" className="secondary compact" disabled={busy} onClick={()=>void onRefresh()}><RefreshCw size={14} className={busy?'dochub-spin':''}/>{busy?'Refreshing':'Refresh'}</button>}{doc.status==='COMPLETED'&&<a className="secondary compact" href={`/api/dochub/documents/${doc.id}/pdf`} target="_blank" rel="noopener noreferrer">Signed PDF</a>}</div>
  </article>
}

function DocHubRow({doc,busy,onRefresh,onOpen,archived}:{doc:DocHubDocument;busy:boolean;onRefresh:()=>Promise<void>;onOpen:()=>void;archived:boolean}) {
  const signers=doc.signers.filter(s=>!s.removed),signed=signers.filter(s=>s.signedAt||s.status==='FINALIZED').length
  return <article className={`dochub-row${archived?' archived':''}`}>
    <div className="dochub-row-document"><span className="dochub-kind">{doc.kind}</span><button type="button" className="dochub-row-title" title={doc.title} onClick={onOpen}>{doc.title}</button><small>{doc.createdByName || 'Unknown user'} · {dateTime(doc.createdAt)}</small></div>
    <div className="dochub-row-status"><span className={`dochub-status${archived?' archived':''}`}>{docHubLabels[doc.status] || doc.status}</span></div>
    <div className="dochub-row-signatures"><strong>{signed}/{signers.length}</strong><small>Signed</small></div>
    <div className="dochub-row-followup"><strong>{doc.followUpDate || '—'}</strong><small>Follow-up</small></div>
    <div className="dochub-tile-actions dochub-row-actions"><button type="button" className="secondary compact" onClick={onOpen}>Details</button>{doc.documentUrl&&<a className="secondary compact" href={doc.documentUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/> Open</a>}{!archived&&<button type="button" className="secondary compact" disabled={busy} onClick={()=>void onRefresh()}><RefreshCw size={14} className={busy?'dochub-spin':''}/>{busy?'Refreshing':'Refresh'}</button>}{doc.status==='COMPLETED'&&<a className="secondary compact" href={`/api/dochub/documents/${doc.id}/pdf`} target="_blank" rel="noopener noreferrer">Signed PDF</a>}</div>
  </article>
}

function DocHubDetails({doc,busy,refresh,onClose}:{doc:DocHubDocument;busy:boolean;refresh:()=>Promise<void>;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const titleId=useId()
  useEffect(()=>{
    const element=dialog.current
    if(!element)return
    const returnFocus=document.activeElement
    const previousOverflow=document.body.style.overflow
    // The native top layer escapes themed panels' backdrop-filter and clipping.
    element.showModal()
    document.body.style.overflow='hidden'
    return()=>{
      element.close()
      document.body.style.overflow=previousOverflow
      if(returnFocus instanceof HTMLElement&&returnFocus.isConnected)returnFocus.focus({preventScroll:true})
    }
  },[])
  return <dialog ref={dialog} className="modal dochub-detail-modal" aria-labelledby={titleId} aria-modal="true"
    onCancel={event=>{event.preventDefault();onClose()}}
    onMouseDown={event=>{
      if(event.button!==0||event.target!==event.currentTarget)return
      const bounds=event.currentTarget.getBoundingClientRect()
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose()
    }}>
    <div className="modal-head"><div><h2 id={titleId}>Document details</h2><p>{doc.kind} · {docHubLabels[doc.status] || doc.status}</p></div><button autoFocus className="icon-button" type="button" aria-label="Close document details" onClick={onClose}><X size={20}/></button></div>
    <div className="dochub-detail-body" tabIndex={0} role="region" aria-label="Document information and signing activity"><DocHubCard doc={doc} busy={busy} refresh={refresh}/></div>
  </dialog>
}

export function DocHubHistory({active=true,taskId,canCreate=false,onComplete}:{active?:boolean;taskId?:string;canCreate?:boolean;onComplete?:()=>void}) {
  const [docs,setDocs]=useState<DocHubDocument[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(''),[view,setView]=useState<'active'|'archive'>('active'),[selected,setSelected]=useState<DocHubDocument|null>(null)
  const [layout,setLayout]=useState<'row'|'tile'>('row'),[pageSize,setPageSize]=useState<3|5|10>(5),[page,setPage]=useState(1)
  const load=async()=>{try{const r=await dochubRequest(`/api/dochub/documents${taskId?`?taskId=${encodeURIComponent(taskId)}`:''}`);setDocs(r.documents);setSelected(current=>current?((r.documents as DocHubDocument[]).find(d=>d.id===current.id)||null):null);setError('')}catch(e){setError((e as Error).message)}}
  const refreshOne=async(id:string)=>{setBusy(id);try{await dochubRequest(`/api/dochub/documents/${id}/refresh`,'POST');await load();updated()}catch(e){setError((e as Error).message)}finally{setBusy('')}}
  useEffect(()=>{if(!active)return;let live=true;const refresh=()=>{if(live)void load()};refresh();const timer=window.setInterval(refresh,30_000);window.addEventListener('dochub-updated',refresh);return()=>{live=false;window.clearInterval(timer);window.removeEventListener('dochub-updated',refresh)}},[active,taskId])
  const archivedDocs=docs.filter(d=>isArchivedDocHubStatus(d.status)),activeDocs=docs.filter(d=>!isArchivedDocHubStatus(d.status)),visibleDocs=taskId?docs:(view==='archive'?archivedDocs:activeDocs)
  const totalPages=Math.max(1,Math.ceil(visibleDocs.length/pageSize))
  useEffect(()=>{setPage(current=>Math.min(current,totalPages))},[totalPages])
  const pageStart=(page-1)*pageSize
  const pagedDocs=taskId?visibleDocs:visibleDocs.slice(pageStart,pageStart+pageSize)
  return <section className={`panel dochub-history${taskId?' span-2':''}`}><div className="panel-heading"><div><h3>{taskId?'Linked documents':'Document history'}</h3><p>{taskId?'Signing updates are added to this work item’s activity comments.':'Active documents stay here while they are being prepared, routed, or signed. Done, completed, and voided documents move to Archive automatically.'}</p></div><button type="button" className="secondary" onClick={()=>void load()}>Reload history</button></div>
    {!taskId&&<><div className="dochub-history-tabs" role="tablist" aria-label="Document history folders"><button type="button" className={view==='active'?'active':''} role="tab" aria-selected={view==='active'} onClick={()=>{setView('active');setPage(1)}}><FolderOpen size={16}/> Active <span>{activeDocs.length}</span></button><button type="button" className={view==='archive'?'active':''} role="tab" aria-selected={view==='archive'} onClick={()=>{setView('archive');setPage(1)}}><Archive size={16}/> Archive <span>{archivedDocs.length}</span></button></div>
    <div className="dochub-history-toolbar"><div className="dochub-layout-switch" role="group" aria-label="Document history layout"><button type="button" className={layout==='row'?'active':''} aria-pressed={layout==='row'} onClick={()=>setLayout('row')}><List size={15}/> Row</button><button type="button" className={layout==='tile'?'active':''} aria-pressed={layout==='tile'} onClick={()=>setLayout('tile')}><LayoutGrid size={15}/> Tile</button></div><label>Items per page<select value={pageSize} onChange={event=>{setPageSize(Number(event.target.value) as 3|5|10);setPage(1)}}><option value={3}>3</option><option value={5}>5</option><option value={10}>10</option></select></label></div></>}
    {taskId&&canCreate&&<div className="dochub-actions">{(['drf','signoff'] as const).map(flow=><button key={flow} type="button" className="secondary" onClick={()=>window.dispatchEvent(new CustomEvent('dochub-create',{detail:{taskId,flow}}))}>Create {flow==='drf'?'DRF':'Sign-Off'} for this work</button>)}</div>}
    {error&&<p className="dochub-history-message" role="alert">{error}</p>}
    {!visibleDocs.length&&!error&&<div className="dochub-history-empty">{taskId?'No documents linked yet.':view==='archive'?'Archive is empty. Completed and voided documents will appear here for tracking.':'No active documents. New or in-route documents will appear here.'}</div>}
    {taskId?pagedDocs.map(doc=><DocHubCard key={doc.id} doc={doc} busy={busy===doc.id} refresh={()=>refreshOne(doc.id)}/>):layout==='tile'?<div className="dochub-history-grid">{pagedDocs.map(doc=><DocHubTile key={doc.id} doc={doc} archived={view==='archive'} busy={busy===doc.id} onOpen={()=>setSelected(doc)} onRefresh={()=>refreshOne(doc.id)}/>)}</div>:<div className="dochub-history-list">{pagedDocs.map(doc=><DocHubRow key={doc.id} doc={doc} archived={view==='archive'} busy={busy===doc.id} onOpen={()=>setSelected(doc)} onRefresh={()=>refreshOne(doc.id)}/>)}</div>}
    {!taskId&&visibleDocs.length>0&&<div className="dochub-pagination"><span>{pageStart+1}–{Math.min(pageStart+pageSize,visibleDocs.length)} of {visibleDocs.length}</span><div><button type="button" className="secondary compact" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(current=>Math.max(1,current-1))}><ChevronLeft size={15}/> Previous</button><span>Page {page} of {totalPages}</span><button type="button" className="secondary compact" aria-label="Next page" disabled={page>=totalPages} onClick={()=>setPage(current=>Math.min(totalPages,current+1))}>Next <ChevronRight size={15}/></button></div></div>}
    {onComplete&&docs.some(d=>d.status==='COMPLETED')&&<div className="dochub-completion"><CheckCircle2 size={18}/><span>Signatures complete. Mark this task/subtask completed?</span><button className="secondary" type="button" onClick={onComplete}>Set completed status</button><small>Review and save your task changes to confirm.</small></div>}
    {active&&selected&&<DocHubDetails key={selected.id} doc={selected} busy={busy===selected.id} refresh={()=>refreshOne(selected.id)} onClose={()=>setSelected(null)}/>}  
  </section>
}

export function DocHubSettings() {
  const [data,setData]=useState<any>(null),[key,setKey]=useState(''),[secret,setSecret]=useState(''),[enabled,setEnabled]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const load=async()=>{const value=await dochubRequest('/api/account/dochub');setData(value);setEnabled(value.configured?value.enabled:true)}
  useEffect(()=>{void load().catch(e=>setMessage(e.message))},[])
  const act=async(action:'save'|'test'|'webhook')=>{setBusy(true);setMessage('');try{const result=action==='save'?await dochubRequest('/api/account/dochub','PUT',{apiKey:key,webhookSecret:secret,enabled}):await dochubRequest(`/api/account/dochub/${action}`,'POST');setKey('');setSecret('');await load();if(action==='save')window.dispatchEvent(new Event('dochub-settings-changed'));setMessage(result.message || (action==='webhook'?'Live completion updates connected.':'DocHub settings saved for this account.'))}catch(e){setMessage((e as Error).message)}finally{setBusy(false)}}
  return <section className="panel dochub-settings"><div className="panel-heading"><div><h2>DocHub integration</h2><p>Only this account uses the API key. Tenant Administrators manage the connection.</p></div><span className="role-badge">{data?.enabled?'Enabled':data?.configured?'Disabled':'Not configured'}</span></div><p>Create a key in <a href="https://dev.dochub.com/settings/api-keys" target="_blank" rel="noopener noreferrer">DocHub API settings</a> with document, recipient-role, formfield-read and sign-request access.</p>
    <div className="integration-form"><label>{data?.configured?'Replace API key (leave blank to keep it)':'DocHub API key'}<input type="password" autoComplete="new-password" value={key} disabled={busy} onChange={e=>setKey(e.target.value)}/><small>{data?.maskedKey}</small></label><label className="dochub-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/> Enable for this account</label></div>
    <details><summary>Live completion notifications</summary><p>Register a webhook for prompt updates. The server also checks pending documents every minute while running.</p><label>Webhook URL<input readOnly value={data?.webhookUrl || 'Set APP_BASE_URL on the server to show the callback URL.'}/></label><button type="button" className="secondary" disabled={busy||!data?.enabled||!data?.webhookUrl||data?.webhookRegistered} onClick={()=>void act('webhook')}>{data?.webhookRegistered?'Webhook registered':'Register DocHub webhook'}</button><label>Webhook signing secret (manual setup or rotation)<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)}/><small>{data?.webhookConfigured?'A signing secret is saved.':'Optional when using background checks.'}</small></label><p>For manual setup, subscribe to document.status_changed, sign_request.created, sign_request.voided, signer.finalized and signer.rejected.</p></details>
    <div className="dochub-actions"><button type="button" className="primary" disabled={busy||data?.encryptionReady===false} onClick={()=>void act('save')}>{busy?'Working…':'Save DocHub settings'}</button><button type="button" className="secondary" disabled={busy||!data?.enabled} onClick={()=>void act('test')}>Test connection</button></div>{data?.encryptionReady===false&&<p role="alert">Internal Admin must configure integration encryption on the server.</p>}{message&&<p role="status">{message}</p>}<small>Keys are encrypted on the server and never returned to the browser after saving. Draft preparation does not send signing invitations.</small>
  </section>
}
