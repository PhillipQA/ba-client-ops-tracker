import { useEffect, useRef, useState } from 'react'
import { LayoutGrid, List, ChevronLeft, ChevronRight } from 'lucide-react'
import type { Client, Project, UserAccount } from './types'
import './communications.css'

type Message = { id:string;source:'Gmail'|'Discord'|'Manual';subject:string;body:string;sender:string;source_label?:string;source_labels?:string[];thread_id?:string;attachments?:string[];status:string;received_at:string;linked_task_id?:string }
type Settings = { discordUserId:string;captureMentions:boolean;gmailEmail:string;gmailLabels:string[];gmailLabelCatalog:Label[];gmailConnected:boolean;gmailReconnectRequired:boolean;gmailAvailable:boolean;gmailPlatformEnabled:boolean;callbackUrl:string }
type Label = {id:string;name:string}
type ViewPreferences = {layout:'cards'|'rows';pageSize:5|10|15}
function readView(key:string):ViewPreferences {
  try { const value=JSON.parse(localStorage.getItem(key) || '{}');return {layout:value.layout==='rows'?'rows':'cards',pageSize:value.pageSizeVersion===2 && [5,10,15].includes(value.pageSize)?value.pageSize:5} }
  catch { return {layout:'cards',pageSize:5} }
}
async function request(url:string,method='GET',body?:unknown) {
  const response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)})
  const result=await response.json()
  if(!response.ok) throw new Error(result.error || 'Communication request failed.')
  return result
}
export default function CommunicationsHub({clients,projects,accounts,currentUser,onTaskCreated}:{clients:Client[];projects:Project[];accounts:UserAccount[];currentUser:UserAccount;onTaskCreated:()=>Promise<void>}) {
  const [items,setItems]=useState<Message[]>([]),[settings,setSettings]=useState<Settings|null>(null),[labels,setLabels]=useState<Label[]>([])
  const [tab,setTab]=useState('All'),[labelFilter,setLabelFilter]=useState(''),[selected,setSelected]=useState<Message|null>(null),[compose,setCompose]=useState(false),[config,setConfig]=useState(false)
  const [title,setTitle]=useState(''),[description,setDescription]=useState(''),[clientId,setClientId]=useState(''),[projectId,setProjectId]=useState(''),[assignee,setAssignee]=useState(currentUser.id)
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const [gmailStatus,setGmailStatus]=useState('')
  const gmailRefresh=useRef<Promise<{imported:number;updated:number;hasMore:boolean}|null>|null>(null)
  const detailRef=useRef<HTMLDivElement>(null)
  const [openCount,setOpenCount]=useState(0),[labelsLoading,setLabelsLoading]=useState(false)
  const viewKey=`communications-view:${currentUser.organizationId || ''}:${currentUser.id}`
  const [view,setView]=useState<ViewPreferences>(()=>readView(viewKey))
  const [page,setPage]=useState(1),[total,setTotal]=useState(0),[loading,setLoading]=useState(true),[listError,setListError]=useState(''),[refresh,setRefresh]=useState(0)
  const [selectedThread,setSelectedThread]=useState<Message[]>([]),[threadPage,setThreadPage]=useState(1),[threadTotal,setThreadTotal]=useState(0),[threadLoading,setThreadLoading]=useState(false),[threadError,setThreadError]=useState(''),[threadRetry,setThreadRetry]=useState(0)
  const changeView=(next:ViewPreferences)=>{setView(next);if(next.pageSize!==view.pageSize)setPage(1);try{localStorage.setItem(viewKey,JSON.stringify({...next,pageSizeVersion:2}))}catch{/* Preferences still work when browser storage is unavailable. */}}
  const load=async()=>{
    const prefs:Settings=await request('/api/communications/settings')
    const catalog=prefs.gmailLabelCatalog || []
    setSettings(prefs);setLabels(catalog);setRefresh(value=>value+1)
    return prefs
  }
  const refreshGmail=(prefs?:Settings,manual=false):Promise<{imported:number;updated:number;hasMore:boolean}|null>=>{
    // A settings save must run again with the newly selected labels, even if
    // the initial check is still finishing.
    if(gmailRefresh.current)return prefs ? gmailRefresh.current.then(()=>refreshGmail(prefs,manual)) : gmailRefresh.current
    const pending=(async()=>{
      const current=prefs || await request('/api/communications/settings') as Settings
      if(!current.gmailConnected || !current.gmailAvailable){setGmailStatus('');return null}
      setGmailStatus('Checking Gmail…')
      setLabelsLoading(true)
      let labelError=''
      try { const result=await request('/api/communications/gmail/labels');setLabels(result.labels) }
      catch(e){labelError=e instanceof Error?e.message:'Could not update Gmail labels.'}
      finally{setLabelsLoading(false)}
      if(!current.gmailLabels.length){setGmailStatus(labelError || 'Select labels and save settings to start automatic Gmail sync.');return null}
      try {
        const result=await request('/api/communications/gmail/sync','POST',{auto:!manual}) as {imported:number;updated:number;hasMore:boolean}
        setRefresh(value=>value+1)
        setGmailStatus(labelError || `Gmail checked ${new Date().toLocaleTimeString()}${result.hasMore?' · More older messages will sync on the next check.':''}`)
        return result
      } catch(e){setGmailStatus(e instanceof Error?`Gmail sync: ${e.message}`:'Gmail sync failed.');return null}
    })().finally(()=>{gmailRefresh.current=null})
    gmailRefresh.current=pending
    return pending
  }
  useEffect(()=>{
    if(!openCount)return
    const frame=requestAnimationFrame(()=>{
      const detail=detailRef.current
      if(!detail)return
      const topbar=detail.closest('.app-shell')?.querySelector('.topbar')
      detail.style.scrollMarginTop=`${(topbar?.getBoundingClientRect().height || 0)+16}px`
      detail.focus({preventScroll:true})
      detail.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})
    })
    return()=>cancelAnimationFrame(frame)
  },[openCount])
  useEffect(()=>{setView(readView(viewKey));setPage(1);setSelected(null);setItems([])},[viewKey])
  useEffect(()=>{
    let active=true;setLoading(true);setListError('')
    const query=new URLSearchParams({page:String(page),pageSize:String(view.pageSize),tab,...(tab==='Gmail' && labelFilter?{label:labelFilter}:{})})
    void request(`/api/communications?${query}`).then(result=>{
      if(!active)return
      const lastPage=Math.max(1,Math.ceil(result.total/view.pageSize))
      if(page>lastPage){setPage(lastPage);return}
      setItems(result.items);setTotal(result.total);setLoading(false)
    }).catch(e=>{if(active){setListError(e.message);setLoading(false);setItems([]);setTotal(0)}})
    return()=>{active=false}
  },[viewKey,tab,labelFilter,page,view.pageSize,refresh])
  useEffect(()=>{
    if(!selected)return
    let active=true;setThreadLoading(true);setThreadError('')
    void request(`/api/communications/${selected.id}/thread?page=${threadPage}`).then(result=>{
      if(active){setSelectedThread(previous=>threadPage===1?result.items:[...previous,...result.items]);setThreadTotal(result.total);setThreadLoading(false)}
    }).catch(e=>{if(active){setThreadError(e.message);setThreadLoading(false)}})
    return()=>{active=false}
  },[selected?.id,threadPage,threadRetry])
  useEffect(()=>{
    const result=new URLSearchParams(window.location.hash.slice(1)).get('gmail')
    if(result){setMessage(result==='connected'?'Your Gmail account is connected. Select the labels to monitor and save settings; messages will sync automatically.':result==='denied'?'Gmail authorization was cancelled.':'Gmail connection did not complete. Check the account OAuth settings, redirect URI, and your Google test-user access.');window.history.replaceState(null,'',window.location.pathname+window.location.search)}
    void load().then(prefs=>refreshGmail(prefs)).catch(e=>setMessage(e.message))
    const check=()=>{if(document.visibilityState==='visible' && navigator.onLine)void refreshGmail()}
    const timer=window.setInterval(check,5*60*1000)
    document.addEventListener('visibilitychange',check)
    window.addEventListener('online',check)
    return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',check);window.removeEventListener('online',check)}
  },[currentUser.id,currentUser.organizationId])
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn()}catch(e){setMessage(e instanceof Error?e.message:'Request failed.')}finally{setBusy(false)}}
  const saveSettings=()=>act(async()=>{await request('/api/communications/settings','PUT',settings);const prefs=await load();await refreshGmail(prefs);setMessage('Your communication preferences were saved. Gmail sync is automatic.')})
  const beginGmail=()=>act(async()=>{const result=await request('/api/communications/gmail/connect');window.location.assign(result.url)})
  const fetchLabels=()=>act(async()=>{setLabelsLoading(true);try{const result=await request('/api/communications/gmail/labels');setLabels(result.labels)}finally{setLabelsLoading(false)}})
  const sync=()=>act(async()=>{const result=await refreshGmail(undefined,true);if(result)setMessage(`${result.imported} Gmail messages imported; ${result.updated || 0} refreshed.${result.hasMore?' More older messages will sync on the next check.':''}`)})
  const update=(status:string)=>act(async()=>{if(!selected)return;await request(`/api/communications/${selected.id}`,'PATCH',{status});await load();setSelected(null)})
  const createTask=()=>act(async()=>{if(!selected)return;await request(`/api/communications/${selected.id}/create-task`,'POST',{title,description,clientId,projectId,assignedToUserId:assignee});await onTaskCreated();await load();setSelected(null);setCompose(false);setMessage('Task created. The original communication remains private to you.')})
  const pages=Math.max(1,Math.ceil(total/view.pageSize))
  const openMessage=(item:Message)=>{setSelected(item);setOpenCount(value=>value+1);setSelectedThread([]);setThreadPage(1);setThreadTotal(0);setThreadError('');setThreadRetry(value=>value+1);setCompose(false);setTitle(item.subject || 'Follow up');setDescription('');setClientId('');setProjectId('');setAssignee(currentUser.id)}
  return <section className="communications-hub page-stack">
    <div className="panel communications-heading"><div><h2>My Communications</h2><p>Your Gmail and Discord messages are private. Only details you type into a project task are shared with its assignee.</p></div><div className="integration-actions"><button className="secondary" onClick={()=>setConfig(!config)}>My integration settings</button><button className="primary" disabled={currentUser.role==='Viewer'} onClick={()=>{setSelected(null);setCompose(true);setTitle('');setDescription('')}}>+ New communication</button></div></div>
    {message && <p className="settings-message" role="status">{message}</p>}
    {gmailStatus && <p className="settings-message" role="status">{gmailStatus}</p>}
    {config && settings && <div className="panel communication-settings"><div className="panel-heading"><h2>My integration settings</h2></div>
      <div className="communication-settings-grid"><div><h3>Gmail</h3><p>{settings.gmailConnected ? `Connected: ${settings.gmailEmail}` : 'Connect your own Google account to import messages from selected Gmail labels.'}</p>
        {settings.gmailAvailable ? settings.gmailConnected ? <><small>Labels and selected messages check automatically when you open this Hub and every five minutes while it is open.</small><button className="secondary" disabled={busy || labelsLoading} onClick={fetchLabels}>Refresh Gmail labels</button><button className="secondary" disabled={busy} onClick={sync}>Check Gmail now</button><button className="secondary danger-button" disabled={busy} onClick={()=>{if(window.confirm('Disconnect your Gmail account? Imported private messages remain in your Hub.'))void act(async()=>{await request('/api/communications/gmail','DELETE');await load();setGmailStatus('')})}}>Disconnect</button></> : <button className="primary" disabled={busy} onClick={beginGmail}>{settings.gmailReconnectRequired?'Reconnect Gmail':'Connect Gmail'}</button> : <small>{settings.gmailPlatformEnabled?'Ask your account administrator to configure Gmail in Settings → Integrations.':'Internal Admin must enable Gmail for this account first.'}</small>}
        {labels.length>0 && <div className="communication-labels">{labels.map(label=><label key={label.id}><input type="checkbox" checked={settings.gmailLabels.includes(label.id)} onChange={e=>setSettings({...settings,gmailLabels:e.target.checked?[...settings.gmailLabels,label.id]:settings.gmailLabels.filter(id=>id!==label.id)})}/>{label.name}</label>)}</div>}
        {settings.gmailLabels.length>0 && !labels.length && <p>Monitoring {settings.gmailLabels.length} saved label{settings.gmailLabels.length===1?'':'s'}. Refresh labels to change them.</p>}
      </div><div><h3>Discord</h3><p>Link your personal Discord user ID. The existing workspace bot routes mentions of you and your DMs to the bot into your private Hub.</p><label>My Discord user ID<input value={settings.discordUserId} onChange={e=>setSettings({...settings,discordUserId:e.target.value})} placeholder="Numeric Discord user ID" /></label><label className="checkbox-label"><input type="checkbox" checked={settings.captureMentions} onChange={e=>setSettings({...settings,captureMentions:e.target.checked})}/>Capture mentions of me</label><small>Personal person-to-person DMs cannot be captured by the bot. The bot needs access to the server channel and message content.</small></div></div>
      <button className="primary" disabled={busy} onClick={saveSettings}>Save my settings</button>
    </div>}
    <div className="panel communication-results">
      <div className="communication-tabs" role="group" aria-label="Communication source">{['All','Gmail','Discord','Manual','Archived'].map(value=><button key={value} className={tab===value?'active':''} aria-pressed={tab===value} onClick={()=>{setTab(value);setPage(1);setSelected(null);setCompose(false)}}>{value}</button>)}</div>
      <div className="communication-toolbar">
        {tab==='Gmail' && settings?.gmailLabels.length ? <label className="communication-label-filter">Gmail label <select value={labelFilter} onChange={e=>{setLabelFilter(e.target.value);setPage(1)}}><option value="">All monitored labels</option>{settings.gmailLabels.map((id,index)=><option key={id} value={id}>{labels.find(x=>x.id===id)?.name || (labelsLoading?`Loading label ${index+1}…`:`Unavailable label ${index+1}`)}</option>)}</select></label> : <span className="communication-view-title">{tab==='All'?'All communications':tab==='Archived'?'Archived communications':`${tab} communications`}</span>}
        <div className="communication-view-controls"><div className="communication-layout" role="group" aria-label="Communication layout">
          <button aria-pressed={view.layout==='cards'} onClick={()=>changeView({...view,layout:'cards'})}><LayoutGrid size={16} aria-hidden="true"/>Cards</button>
          <button aria-pressed={view.layout==='rows'} onClick={()=>changeView({...view,layout:'rows'})}><List size={16} aria-hidden="true"/>Rows</button>
        </div><label className="communication-page-size">Per page <select value={view.pageSize} onChange={e=>changeView({...view,pageSize:Number(e.target.value) as ViewPreferences['pageSize']})}>{[5,10,15].map(size=><option key={size} value={size}>{size}</option>)}</select></label></div>
      </div>
      <div aria-busy={loading}>
        {loading ? <p className="communication-empty" role="status">Loading communications…</p> : listError ? <div className="communication-empty" role="alert">{listError} <button className="secondary" onClick={()=>setRefresh(value=>value+1)}>Retry</button></div> : items.length ? <div className={`communication-list communication-list--${view.layout}`}>{items.map(item=><button key={item.id} className="communication-card" aria-pressed={selected?.id===item.id} onClick={()=>openMessage(item)}>
          <span className="communication-card-meta"><strong className="communication-source">{item.source}</strong><span className="communication-status">{item.status}</span><time dateTime={item.received_at}>{new Date(item.received_at).toLocaleString()}</time></span>
          <span className="communication-card-content"><span className="communication-subject">{item.subject || 'Untitled communication'}</span><span className="communication-sender">{item.sender}</span><span className="communication-preview">{item.body.slice(0,180) || 'Open to review this message.'}</span></span>
          <span className="communication-card-footer">{item.linked_task_id && <span className="communication-task-badge">Task created</span>}<span className="communication-open">Open message <ChevronRight size={15} aria-hidden="true"/></span></span>
        </button>)}</div>:<p className="communication-empty">No communications in this view.</p>}
      </div>
      <div className="communication-pagination"><span role="status">{loading?'Loading…':listError?'Unable to load communications':total?`Showing ${(page-1)*view.pageSize+1}–${Math.min(page*view.pageSize,total)} of ${total}`:'Showing 0 communications'}</span><div className="communication-page-buttons"><button className="secondary" aria-label="Previous page" disabled={loading || Boolean(listError) || page<=1} onClick={()=>setPage(value=>value-1)}><ChevronLeft size={16} aria-hidden="true"/>Previous</button><span>Page {page} of {pages}</span><button className="secondary" aria-label="Next page" disabled={loading || Boolean(listError) || page>=pages} onClick={()=>setPage(value=>value+1)}>Next<ChevronRight size={16} aria-hidden="true"/></button></div></div>
    </div>
    {(selected || compose) && <div className="panel communication-detail" ref={detailRef} tabIndex={-1} role="region" aria-label="Message details"><div className="panel-heading"><div><h2>{selected ? selected.subject || 'Communication' : 'New private communication'}</h2><p>{selected ? `${selected.source} · ${selected.sender} · ${selected.status}` : 'Visible only to your account'}</p></div><button className="secondary" onClick={()=>{setSelected(null);setCompose(false)}}>Close</button></div>
      {selected ? <><div className="communication-body">{threadLoading && !selectedThread.length ? <p role="status">Loading thread…</p> : threadError && !selectedThread.length ? <p role="alert">{threadError} <button className="secondary" onClick={()=>setThreadRetry(value=>value+1)}>Retry thread</button></p> : selectedThread.length > 1 ? selectedThread.map(entry=><article key={entry.id} className="communication-thread-message"><strong>{entry.sender} · {new Date(entry.received_at).toLocaleString()}</strong><p>{entry.body || 'No plain text body available.'}</p>{entry.attachments?.length ? <small>Attachments: {entry.attachments.join(', ')}</small> : null}</article>) : <>{selected.body || 'No plain text body available.'}{selected.attachments?.length ? <p>Attachments: {selected.attachments.join(', ')}</p> : null}</>}{threadError && selectedThread.length>0 && <p role="alert">{threadError} <button className="secondary" onClick={()=>setThreadRetry(value=>value+1)}>Retry thread</button></p>}{!threadError && selectedThread.length>0 && selectedThread.length<threadTotal && <button className="secondary" disabled={threadLoading} onClick={()=>setThreadPage(value=>value+1)}>{threadLoading?'Loading…':`Load more thread messages (${selectedThread.length} of ${threadTotal})`}</button>}</div><div className="integration-actions">{selected.status!=='Resolved' && <button className="secondary" disabled={busy} onClick={()=>update('Resolved')}>Resolve</button>}{selected.status!=='Archived' && <button className="secondary" disabled={busy} onClick={()=>update('Archived')}>Archive</button>}{selected.status==='Archived' && <button className="secondary" disabled={busy} onClick={()=>update('Open')}>Restore</button>}</div></>:null}
      {!selected && compose ? <><label>Subject<input value={title} onChange={e=>setTitle(e.target.value)} /></label><label>Message<textarea value={description} onChange={e=>setDescription(e.target.value)} /></label><button className="primary" disabled={busy} onClick={()=>void act(async()=>{await request('/api/communications','POST',{subject:title,body:description});await load();setCompose(false)})}>Save private communication</button></>:null}
      {selected && currentUser.role!=='Viewer' && <div className="communication-task-form"><h3>Create a project task</h3><p>Enter only the information User B should see. The email or Discord thread and sender are never copied into the task.</p><div className="communication-fields"><label>Task title<input value={title} maxLength={200} onChange={e=>setTitle(e.target.value)} /></label><label>Client<select value={clientId} onChange={e=>setClientId(e.target.value)}><option value="">Select client</option>{clients.filter(x=>!x.archived).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Project<select value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Select project</option>{projects.filter(x=>!x.archived).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Assign to<select value={assignee} onChange={e=>setAssignee(e.target.value)}>{accounts.filter(x=>x.status!=='Disabled' && x.role!=='Viewer').map(x=><option key={x.id} value={x.id}>{x.name || x.username}</option>)}</select></label></div><label>Shared task description<textarea value={description} maxLength={5000} onChange={e=>setDescription(e.target.value)} placeholder="Write a summary for the assignee. The private message is not included." /></label><button className="primary" disabled={busy || !title.trim() || !clientId || !projectId || !assignee} onClick={createTask}>Create task without sharing thread</button></div>}
    </div>}
  </section>
}
