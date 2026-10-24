import React, { useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, ExternalLink, ChevronLeft, ChevronRight, Link, Plus } from 'lucide-react'
import { GITHUB_QA_STATUSES, type GithubConnection, type GithubRepository, type GithubTicket, type GithubComment } from './github-model'
import type { Client, Project, TaskSettings, UserAccount, WaitingOn, WorkItem } from './types'
import { defaultWaitingOn, waitingOnOptions } from './waitingOn'
import { workHubSync } from './workHubSync'
import { useWorkHubSync } from './useWorkHubSync'
import { useIsClosed } from './openWork'

class ApiError extends Error { constructor(message: string, public retryAfterSeconds?: number) { super(message) } }
async function apiRequest(root: string, path: string, method='GET', body?: unknown, signal?: AbortSignal) {
  const response = await fetch(root+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal})
  const result = await response.json()
  if(!response.ok)throw new ApiError(result.error || 'Ticket request failed.',result.retryAfterSeconds)
  return result
}
export type Props = { provider?: 'github' | 'gitlab'; clients: Client[]; projects: Project[]; accounts: UserAccount[]; tasks: WorkItem[]; taskSettings?: TaskSettings; currentUser: UserAccount; onTaskCreated: () => Promise<void> }
const qaClass = (status: string) => `github-qa github-qa--${status.toLowerCase().replace(/ /g,'-')}`
function displayDate(value: string | null) { return value ? new Date(value).toLocaleString() : 'Not synced yet' }

export default function GithubHub({clients,projects,accounts,tasks,taskSettings,currentUser,onTaskCreated,provider='github'}: Props) {
  const providerLabel=provider==='gitlab'?'GitLab':'GitHub'
  const request=(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>method==='GET' && path.startsWith('/tickets') ? workHubSync.read(provider,`/api/work-hub/${provider}${path}`,signal) : apiRequest(`/api/work-hub/${provider}`,path,method,body,signal)
  const hubSync=useWorkHubSync(),syncStatus=hubSync.integrations[provider]
  const [baseUrl,setBaseUrl]=useState('https://gitlab.com')
  const [connection,setConnection] = useState<GithubConnection|null>(null),[settingsOpen,setSettingsOpen] = useState(false),[token,setToken] = useState('')
  const [repositoryDraft,setRepositoryDraft] = useState<GithubRepository[]>([]),[catalog,setCatalog] = useState<{fullName:string;private:boolean}[]>([]),[repositoryPage,setRepositoryPage] = useState(0),[moreRepositories,setMoreRepositories] = useState(false),[manualRepository,setManualRepository] = useState('')
  const [message,setMessage] = useState(''),[acting,setWorking] = useState(false)
  const working=acting || syncStatus.phase==='syncing'
  const [items,setItems] = useState<GithubTicket[]>([]),[loading,setLoading] = useState(true),[listError,setListError] = useState(''),[total,setTotal] = useState(0),[page,setPage] = useState(1),[pageSize,setPageSize] = useState(5),[refresh,setRefresh] = useState(0)
  const [view,setView] = useState('all'),[repository,setRepository] = useState(''),[state,setState] = useState('open'),[qa,setQa] = useState(''),[label,setLabel] = useState(''),[search,setSearch] = useState(''),[query,setQuery] = useState('')
  const [selected,setSelected] = useState<GithubTicket|null>(null),[comments,setComments] = useState<GithubComment[]>([]),[commentError,setCommentError] = useState(''),[commentsReady,setCommentsReady] = useState(false),[detailLoading,setDetailLoading] = useState(false),[detailRefresh,setDetailRefresh] = useState(0)
  const [form,setForm] = useState<'create'|'link'|null>(null),[title,setTitle] = useState(''),[description,setDescription] = useState(''),[clientId,setClientId] = useState(''),[projectId,setProjectId] = useState(''),[assignee,setAssignee] = useState(currentUser.id),[taskId,setTaskId] = useState(''),[taskSearch,setTaskSearch] = useState('')
  const [waitingOn,setWaitingOn] = useState<WaitingOn>(()=>defaultWaitingOn(taskSettings)),[startDate,setStartDate] = useState(''),[dueDate,setDueDate] = useState(''),[followUpDate,setFollowUpDate] = useState('')
  const scheduleError = startDate && dueDate && dueDate < startDate ? 'Due date cannot be earlier than start date.' : ''
  const syncJob = useRef(false), alive = useRef(true), detailRef = useRef<HTMLDivElement>(null)
  const openedAtRevision = useRef(0)
  const canWriteTasks = currentUser.role!=='Viewer' && (currentUser.role==='Administrator' || currentUser.modules.includes('items'))
  const maps = connection?.repositories || [], pages = Math.max(1,Math.ceil(total/pageSize))
  const mapping = (repo: string) => maps.find(r=>r.fullName===repo)
  const clientName = (id?: string) => clients.find(c=>c.id===id)?.name || 'Unmapped'
  const projectName = (id?: string) => projects.find(p=>p.id===id)?.name || 'Unmapped'


  useEffect(()=>{alive.current=true;const controller=new AbortController();void request('/connection','GET',undefined,controller.signal).then(result=>{setConnection(result);setBaseUrl(result.baseUrl || 'https://gitlab.com');setRepositoryDraft(result.repositories);if(!result.connected || !result.repositories.length)setSettingsOpen(true)}).catch(e=>{if(e.name!=='AbortError'){setMessage(e.message);setLoading(false)}});return()=>{alive.current=false;controller.abort()}},[])
  useEffect(()=>{
    if(!syncStatus.revision)return
    const controller=new AbortController()
    void request('/connection','GET',undefined,controller.signal).then(result=>setConnection(previous=>({...result,repositories:JSON.stringify(previous?.repositories)===JSON.stringify(result.repositories)?previous!.repositories:result.repositories}))).catch(e=>{if(e.name!=='AbortError')setMessage(e.message)})
    return()=>controller.abort()
  },[syncStatus.revision])
  useEffect(()=>{const timer=setTimeout(()=>{setQuery(search.trim());setPage(1)},300);return()=>clearTimeout(timer)},[search])
  useEffect(()=>{setPage(1);setSelected(null);setForm(null)},[view,repository,state,qa,label,pageSize])
  useEffect(()=>{
    if(!connection)return
    const controller=new AbortController();setLoading(true);setListError('')
    const params=new URLSearchParams({page:String(page),pageSize:String(pageSize),view,state,repository,qa,label,q:query})
    void request(`/tickets?${params}`,'GET',undefined,controller.signal).then(result=>{
      const last=Math.max(1,Math.ceil(result.total/pageSize));if(page>last){setPage(last);return}
      setItems(result.items);setTotal(result.total);setLoading(false)
      setSelected(previous=>previous ? result.items.find((i:GithubTicket)=>i.id===previous.id) || null : null)
    }).catch(e=>{if(e.name!=='AbortError'){setListError(e.message);setLoading(false);setItems([]);setTotal(0)}})
    return()=>controller.abort()
  },[connection?.login,connection?.repositories,page,pageSize,view,state,repository,qa,label,query,refresh,syncStatus.revision])
  useEffect(()=>{
    if(!selected){setComments([]);return}
    const path=`/tickets/${selected.id}`
    if(syncStatus.revision<=openedAtRevision.current){
      const cached=workHubSync.peek(provider,`/api/work-hub/${provider}${path}`)
      setComments(cached?.comments || []);setCommentError(cached?.commentError || '');setCommentsReady(Boolean(cached));setDetailLoading(false)
      return
    }
    // Ticket selection shows saved data. Only a source sync performed while
    // this ticket is open may fetch its latest comments from the provider.
    const controller=new AbortController();setDetailLoading(true);setComments([]);setCommentError('')
    void request(path,'GET',undefined,controller.signal).then(result=>{setComments(result.comments);setCommentError(result.commentError);setCommentsReady(true);setDetailLoading(false)}).catch(e=>{if(e.name!=='AbortError'){setCommentError(e.message);setDetailLoading(false)}})
    return()=>controller.abort()
  },[selected?.id,detailRefresh,syncStatus.revision])

  const sync = () => workHubSync.syncOne(provider)
  const reloadTickets=()=>{workHubSync.invalidate(provider);setRefresh(v=>v+1)}
  const act = async(fn:()=>Promise<void>) => {
    if(syncJob.current || syncStatus.phase==='syncing')return
    syncJob.current=true;setWorking(true);setMessage('')
    try{await fn()}catch(e){if(alive.current)setMessage(e instanceof Error?e.message:`${providerLabel} update failed.`)}
    finally{syncJob.current=false;if(alive.current)setWorking(false)}
  }
  const loadRepositories = async(page=1) => {
    const result=await request(`/repositories?page=${page}`)
    setCatalog(previous=>page===1?result.repositories:[...new Map([...previous,...result.repositories].map(r=>[r.fullName,r])).values()]);setRepositoryPage(page);setMoreRepositories(result.hasMore)
  }
  const connect = () => void act(async()=>{
    const result=await request('/connection','PUT',{token,...(provider==='gitlab'?{baseUrl}:{})});setToken('');setConnection(result);setBaseUrl(result.baseUrl || 'https://gitlab.com');setRepositoryDraft(result.repositories);setRepository('');setSelected(null);setItems([]);reloadTickets();setMessage(`Connected as ${result.login}. Select repositories and save your settings.`);await loadRepositories()
  })
  const chooseRepository = (name: string, include: boolean) => {
    if(include && repositoryDraft.length>=20){setMessage('Select up to 20 repositories.');return}
    setRepositoryDraft(previous=>include ? [...previous,{fullName:name,clientId:'',projectId:''}] : previous.filter(r=>r.fullName!==name))
  }
  const saveRepositories = () => void act(async()=>{
    const result=await request('/repositories','PUT',{repositories:repositoryDraft});setConnection(result);setRepositoryDraft(result.repositories);setRepository('');setSelected(null);reloadTickets();setSettingsOpen(false);setMessage('Your repositories and client/project mappings were saved.')
  })
  const openTicket = (ticket: GithubTicket) => {
    openedAtRevision.current=syncStatus.revision
    setSelected(ticket);setDetailRefresh(v=>v+1);setForm(null);setTaskId('');setTaskSearch('');setDescription('');setTitle(ticket.title.slice(0,200));setAssignee(currentUser.id);setWaitingOn(defaultWaitingOn(taskSettings));setStartDate('');setDueDate('');setFollowUpDate('')
    const map=mapping(ticket.repository);setClientId(map?.clientId || '');setProjectId(map?.projectId || '')
    if(window.matchMedia('(max-width: 1100px)').matches)requestAnimationFrame(()=>detailRef.current?.scrollIntoView({behavior:'smooth',block:'start'}))
  }
  const updateTicket = (ticket: GithubTicket) => {setSelected(ticket);setItems(previous=>previous.map(i=>i.id===ticket.id?ticket:i));reloadTickets()}
  const setQaStatus = (value: string) => void act(async()=>{if(!selected)return;const result=await request(`/tickets/${selected.id}`,'PATCH',{qaStatus:value});updateTicket(result.ticket)})
  const createTask = () => void act(async()=>{
    if(!selected)return
    const result=await request(`/tickets/${selected.id}/create-task`,'POST',{title,description,clientId,projectId,assignedToUserId:assignee,waitingOn,startDate,dueDate,followUpDate});updateTicket(result.ticket);setForm(null);setMessage(`Task created. Your ${providerLabel} ticket and comments remain private.`);await onTaskCreated()
  })
  const linkTask = (id=taskId) => void act(async()=>{if(!selected)return;const result=await request(`/tickets/${selected.id}/link-task`,'POST',{taskId:id});updateTicket(result.ticket);setForm(null);setMessage(id?'Ticket linked to the selected task.':'Task link removed.')})
  const isClosed=useIsClosed()
  const availableTasks=tasks.filter(t=>t.type==='Task' && !isClosed(t.status) && (!taskSearch || `${t.title} ${clientName(t.clientId)} ${projectName(t.projectId)}`.toLowerCase().includes(taskSearch.toLowerCase())))
  const linkedTask=tasks.find(t=>t.id===selected?.linked_task_id)
  const latestComment=comments[comments.length-1]

  return <div className="github-hub">
    <div className="github-connection-bar"><div><GitBranch size={24}/><span>{connection?.connected?`Connected as ${connection.login}`:`Connect your personal ${providerLabel} account`}<small>{connection?.lastSyncedAt?`Last sync: ${displayDate(connection.lastSyncedAt)}`:'Pull issues you created or are assigned to.'}</small></span></div><div className="integration-actions"><button className="secondary" disabled={working} onClick={()=>{setRepositoryDraft(maps);setSettingsOpen(v=>!v)}}>My {providerLabel} settings</button><button className="primary" disabled={working || !connection?.connected || !maps.length} onClick={()=>void sync()}><RefreshCw size={15}/>{working?'Working…':`Sync ${providerLabel}`}</button></div></div>
    {message && <p className="settings-message" role="status">{message}</p>}{syncStatus.phase==='skipped' && <p className="settings-message" role="status">{syncStatus.message}</p>}
    {settingsOpen && <div className="github-settings"><h3>My {providerLabel} settings</h3><p>Your token and imported tickets belong only to your user. {providerLabel} is read only; task links and QA status are saved in this tracker.</p>
      {provider==='gitlab' && <label>GitLab website URL<input type="url" disabled={working} value={baseUrl} maxLength={500} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://gitlab.com or https://gitlab.company.com"/><small>Use the website URL for your company’s GitLab. Changing it requires connecting a token for that instance.</small></label>}
      <label>{providerLabel} personal access token<input type="password" autoComplete="new-password" maxLength={255} value={token} onChange={e=>setToken(e.target.value)} placeholder={connection?.connected?'Enter a new token to replace your saved token':`Paste your own ${providerLabel} token`}/></label>
      {provider==='gitlab' ? <p className="github-help">On your GitLab website, open Edit profile → Access → Personal access tokens and create a token (Legacy token, if shown) with <strong>read_api</strong> scope. Paste it here, then select projects you can access. <a href="https://docs.gitlab.com/user/profile/personal_access_tokens/" target="_blank" rel="noopener noreferrer">Token setup help <ExternalLink size={12}/></a></p> : <p className="github-help">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained personal token <ExternalLink size={12}/></a>, select repositories, and give <strong>Issues: Read-only</strong> permission. Organization approval or SSO authorization may be needed.</p>}
      {connection && !connection.encryptionReady && <p role="alert">Your account administrator must configure encrypted integration storage before tokens can be saved.</p>}
      <div className="integration-actions"><button className="primary" disabled={working || !token.trim() || !connection?.encryptionReady} onClick={connect}>{connection?.connected?'Replace my token':`Connect ${providerLabel}`}</button>{connection?.connected && <button className="secondary" disabled={working} onClick={()=>{if(window.confirm(`Disconnect your ${providerLabel} token? Imported tickets and local task links remain private to you.`))void act(async()=>{await request('/connection','DELETE');const result=await request('/connection');setConnection(result);setToken('');setMessage(`${providerLabel} disconnected. Saved tickets remain available.`)})}}>Disconnect {providerLabel}</button>}</div>
      {connection?.connected && <><div className="github-repository-heading"><h4>{provider==='gitlab'?'Projects to monitor':'Repositories to monitor'}</h4><button className="secondary" disabled={working} onClick={()=>void act(()=>loadRepositories())}>{provider==='gitlab'?'Load projects':'Load repositories'}</button></div>
        <div className="github-repository-catalog">{catalog.map(r=><label key={r.fullName}><input type="checkbox" disabled={working} checked={repositoryDraft.some(s=>s.fullName===r.fullName)} onChange={e=>chooseRepository(r.fullName,e.target.checked)}/><span>{r.fullName}<small>{r.private?'Private':'Public'}</small></span></label>)}</div>
        {moreRepositories && <button className="secondary" disabled={working} onClick={()=>void act(()=>loadRepositories(repositoryPage+1))}>{provider==='gitlab'?'Load more projects':'Load more repositories'}</button>}
        <div className="github-add-repository"><label>{provider==='gitlab'?'Or add a project':'Or add a repository'}<input value={manualRepository} maxLength={200} disabled={working} onChange={e=>setManualRepository(e.target.value)} placeholder={provider==='gitlab'?'group/subgroup/project':'owner/repository'}/></label><button className="secondary" disabled={working || !manualRepository.trim()} onClick={()=>{const name=manualRepository.trim();if(!(provider==='gitlab'?/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+$/i:/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i).test(name) || name.split('/').some(p=>/^\.+$/.test(p))){setMessage(provider==='gitlab'?'Use group/project or group/subgroup/project.':'Use owner/repository.');return}if(!repositoryDraft.some(r=>r.fullName.toLowerCase()===name.toLowerCase()))chooseRepository(name,true);setManualRepository('')}}><Plus size={15}/>Add</button></div>
        <div className="github-repository-mappings">{repositoryDraft.map((r,index)=><div key={r.fullName}><strong>{r.fullName}</strong><label>Client<select disabled={working} value={r.clientId} onChange={e=>setRepositoryDraft(previous=>previous.map((p,i)=>i===index?{...p,clientId:e.target.value}:p))}><option value="">Unmapped</option>{clients.filter(c=>!c.archived).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Project<select disabled={working} value={r.projectId} onChange={e=>setRepositoryDraft(previous=>previous.map((p,i)=>i===index?{...p,projectId:e.target.value}:p))}><option value="">Unmapped</option>{projects.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button className="secondary" disabled={working} onClick={()=>chooseRepository(r.fullName,false)}>Remove</button></div>)}</div>
        <p className="github-help">Select up to 20 repositories. Client/project mapping is optional and prefills task creation. Open tickets have no age limit; recently updated closed tickets from the last 30 days are also imported. Removing a repository hides its cached tickets.</p>
        <button className="primary" disabled={working} onClick={saveRepositories}>{provider==='gitlab'?'Save my projects':'Save my repositories'}</button>
      </>}
    </div>}
    {!connection && message ? <div className="communication-empty" role="alert">{providerLabel} is unavailable. Check the message above, then reload Work Hub.</div> : <div className={`github-workspace${selected?' has-detail':''}`}>
      <div className="github-ticket-list"><div className="github-views" role="group" aria-label={`My ${providerLabel} ticket views`}>{[{id:'all',label:'All my tickets'},{id:'assigned',label:'Assigned to me'},{id:'created',label:'Created by me'}].map(v=><button className={view===v.id?'active':''} aria-pressed={view===v.id} key={v.id} onClick={()=>setView(v.id)}>{v.label}</button>)}</div>
        <div className="github-filters"><label>Search tickets<input value={search} maxLength={200} onChange={e=>setSearch(e.target.value)} placeholder="Search ticket titles…"/></label><label>Repository<select value={repository} onChange={e=>setRepository(e.target.value)}><option value="">All repositories</option>{maps.map(r=><option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}</select></label><label>{providerLabel} state<select value={state} onChange={e=>setState(e.target.value)}><option value="open">Open</option><option value="closed">Closed</option><option value="all">All states</option></select></label><label>QA status<select value={qa} onChange={e=>setQa(e.target.value)}><option value="">All QA statuses</option>{GITHUB_QA_STATUSES.map(q=><option key={q}>{q}</option>)}</select></label><label>Label<input value={label} maxLength={100} onChange={e=>setLabel(e.target.value)} placeholder="e.g. bug"/></label></div>
        <div aria-busy={loading} className="github-table-wrap">{loading?<p className="communication-empty" role="status">Loading {providerLabel} tickets…</p>:listError?<p className="communication-empty" role="alert">{listError} <button className="secondary" onClick={()=>reloadTickets()}>Retry</button></p>:items.length?<table className="github-ticket-table"><thead><tr><th>Ticket</th><th>Repository / Client</th><th>{providerLabel}</th><th>QA</th><th>Updated</th></tr></thead><tbody>{items.map(ticket=><tr key={ticket.id} className={selected?.id===ticket.id?'selected':''}><td><button className="github-ticket-title" aria-pressed={selected?.id===ticket.id} onClick={()=>openTicket(ticket)}><strong>#{ticket.number} {ticket.title}</strong><span>{ticket.created_by_me?'Created by me':''}{ticket.created_by_me && ticket.assigned_to_me?' · ':''}{ticket.assigned_to_me?'Assigned to me':''}{ticket.linked_task_id?' · Task linked':''}</span></button></td><td><strong>{ticket.repository}</strong><small>{clientName(mapping(ticket.repository)?.clientId)}</small></td><td><span className={`github-state github-state--${ticket.state}`}>{ticket.state==='open'?'Open':'Closed'}</span></td><td><span className={qaClass(ticket.qa_status)}>{ticket.qa_status}</span></td><td><time dateTime={ticket.updated_at}>{displayDate(ticket.updated_at)}</time></td></tr>)}</tbody></table>:<p className="communication-empty">{!connection?.connected?`Connect ${providerLabel} to pull your tickets.`:!maps.length?`Select repositories in My ${providerLabel} settings.`:`No tickets match these filters. Sync ${providerLabel} or adjust your filters.`}</p>}</div>
        <div className="communication-pagination"><span>{loading?'Loading…':`${total?`${(page-1)*pageSize+1}–${Math.min(page*pageSize,total)}`:'0'} of ${total} tickets`}</span><label>Rows <select value={pageSize} onChange={e=>setPageSize(Number(e.target.value))}>{[5,10,15].map(n=><option key={n}>{n}</option>)}</select></label><div className="communication-page-buttons"><button className="secondary" aria-label="Previous ticket page" disabled={loading || page<=1} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/></button><span>{page} / {pages}</span><button className="secondary" aria-label="Next ticket page" disabled={loading || page>=pages} onClick={()=>setPage(p=>p+1)}><ChevronRight size={16}/></button></div></div>
      </div>
      {selected && <div className="github-ticket-detail" ref={detailRef} role="region" aria-label={`${providerLabel} ticket details`}><div className="github-detail-heading"><h3>#{selected.number} {selected.title}</h3><button className="secondary" onClick={()=>{setSelected(null);setForm(null)}}>Close</button></div><p>{selected.repository}</p><div className="github-badges"><span className={`github-state github-state--${selected.state}`}>{selected.state==='open'?'Open':'Closed'}</span>{selected.labels.map(l=><button className="github-label" key={l} onClick={()=>setLabel(l)}>{l}</button>)}</div>
        <dl className="github-ticket-meta"><dt>Client</dt><dd>{clientName(mapping(selected.repository)?.clientId)}</dd><dt>Project</dt><dd>{projectName(mapping(selected.repository)?.projectId)}</dd><dt>Created by</dt><dd>{selected.creator}</dd><dt>Assigned to</dt><dd>{selected.assignees.join(', ') || 'Unassigned'}</dd>{selected.milestone && <><dt>Milestone</dt><dd>{selected.milestone}</dd></>}</dl>
        <h4>Description</h4><div className="github-description">{selected.body || 'No description supplied.'}</div><h4>Latest comment</h4>{detailLoading?<p role="status">Loading latest comment…</p>:commentError?<p role="alert">{commentError} <button className="secondary" disabled={working} onClick={()=>void sync()}>Retry sync</button></p>:latestComment?<article className="github-comment"><strong>{latestComment.author}</strong><small>{displayDate(latestComment.updatedAt)}</small><p>{latestComment.body}</p><a href={latestComment.url} target="_blank" rel="noopener noreferrer">View comment <ExternalLink size={12}/></a></article>:<p>{!connection?.connected?`Reconnect ${providerLabel} to load comments.`:commentsReady?'No comments yet.':`Click Sync ${providerLabel} with this ticket open to load its latest comment.`}</p>}
        <div className="github-qa-control"><label>My QA status<select value={selected.qa_status} disabled={working} onChange={e=>setQaStatus(e.target.value)}>{GITHUB_QA_STATUSES.map(q=><option key={q}>{q}</option>)}</select></label><div><small>{providerLabel} state</small><span className={`github-state github-state--${selected.state}`}>{selected.state==='open'?'Open':'Closed'}</span></div></div><p className="github-help">QA status is personal to you. Changing it does not close the {providerLabel} issue or complete the linked task.</p>
        <h4>Linked work</h4><p>{selected.linked_task_id?linkedTask?`${linkedTask.parentTaskId?'Subtask':'Task'}: ${linkedTask.title}`:'Linked task is no longer in your current workspace.':'No task linked yet.'}</p>
        <div className="integration-actions">{canWriteTasks && <>{!selected.linked_task_id && <button className="primary" disabled={working} onClick={()=>setForm('create')}><Plus size={14}/>Create task</button>}<button className="secondary" disabled={working} onClick={()=>setForm('link')}><Link size={14}/>{selected.linked_task_id?'Change task link':'Link existing task'}</button>{selected.linked_task_id && <button className="secondary" disabled={working} onClick={()=>linkTask('')}>Unlink</button>}</>}<a className="github-external-link" href={selected.html_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/>Open in {providerLabel}</a></div>
        {form==='link' && <div className="github-task-form"><h4>Link a task or subtask</h4><label>Find task<input value={taskSearch} onChange={e=>setTaskSearch(e.target.value)} placeholder="Search title, client or project"/></label><label>Existing task<select value={taskId} onChange={e=>setTaskId(e.target.value)}><option value="">Select a task or subtask</option>{availableTasks.map(t=><option key={t.id} value={t.id}>{t.parentTaskId?'Subtask':'Task'}: {t.title} · {clientName(t.clientId)}</option>)}</select></label><button className="primary" disabled={working || !taskId} onClick={()=>linkTask()}>Save task link</button><button className="secondary" onClick={()=>setForm(null)}>Cancel</button></div>}
        {form==='create' && <div className="github-task-form"><h4>Create a project task</h4><p>The title and description below will be shared with the team. Review them before creating the task. Ticket comments and your token are kept private.</p><label>Task title<input value={title} maxLength={200} onChange={e=>setTitle(e.target.value)}/></label><label>Client<select value={clientId} onChange={e=>setClientId(e.target.value)}><option value="">Select client</option>{clients.filter(c=>!c.archived).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Project<select value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Select project</option>{projects.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Assign to<select value={assignee} onChange={e=>setAssignee(e.target.value)}>{accounts.filter(a=>a.status!=='Disabled' && a.role!=='Viewer').map(a=><option key={a.id} value={a.id}>{a.name || a.username}</option>)}</select></label><label>Waiting on<select value={waitingOn} onChange={e=>setWaitingOn(e.target.value as WaitingOn)}>{waitingOnOptions(taskSettings).map(o=><option key={o.id} value={o.label}>{o.label}</option>)}</select></label><fieldset className="work-schedule-fields"><legend>Task schedule</legend><p>Set when this task starts, when it is due, and when it needs follow-up. All dates are optional.</p><div className="work-schedule-grid"><label>Start date<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label><label>Due date<input type="date" value={dueDate} min={startDate || undefined} onChange={e=>setDueDate(e.target.value)}/></label><label>Follow-up date<input type="date" value={followUpDate} onChange={e=>setFollowUpDate(e.target.value)}/></label></div>{scheduleError && <p role="alert">{scheduleError}</p>}</fieldset><label>Shared task description<textarea value={description} maxLength={5000} onChange={e=>setDescription(e.target.value)} placeholder="Write the details the assignee should see."/></label><button className="secondary" onClick={()=>setDescription(selected.body.slice(0,5000))}>Copy ticket description into shared task</button><button className="primary" disabled={working || !title.trim() || !clientId || !projectId || !assignee || Boolean(scheduleError)} onClick={createTask}>Create task</button><button className="secondary" onClick={()=>setForm(null)}>Cancel</button></div>}
      </div>}
    </div>}
  </div>
}
