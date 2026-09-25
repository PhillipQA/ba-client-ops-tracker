import rateLimit from 'express-rate-limit'
import express, { type Express, type Request, type Response, type RequestHandler } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { encryptSecret, decryptSecret, encryptionKey } from './tenant-integrations'
import { apiClient, DocHubError, docHubId, docHubUrl, storageUrl, verifyDocHubWebhook, draftPacket, signingStatus } from './dochub-api'
import { archivedWorkReason, workContext, LifecycleError } from '../../src/lifecycle'

type Deps = { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; organizationById: (id: string) => Promise<any>; load: (id: string) => Promise<any>; commit: (id: string, state: any, actor: any, reason: string, before: any, sync?: boolean) => Promise<any>; request?: typeof fetch }
const terminal = new Set(['COMPLETED','REJECTED','VOIDED','EXPIRED'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const types: Record<string,string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
export function validatePreparation(input: any) {
  if (!uuid.test(String(input?.id || ''))) throw new DocHubError('A valid preparation ID is required.')
  if (!['DRF','Sign-Off'].includes(input.kind)) throw new DocHubError('Choose DRF or Sign-Off.')
  const fileName = String(input.fileName || '').replace(/[\\/\r\n]/g,'_').slice(0,180), ext = fileName.split('.').pop()?.toLowerCase() || ''
  const encoded = String(input.fileData || '')
  if (!types[ext] || encoded.length > 21 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new DocHubError('Use a generated PDF, DOCX or XLSX up to 15 MB.')
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new DocHubError('Document must be between 1 byte and 15 MB.')
  if (ext === 'pdf') { if (bytes.subarray(0,5).toString() !== '%PDF-') throw new DocHubError('Invalid PDF file.') }
  else { try { const zip = new PizZip(bytes); if (!zip.file('[Content_Types].xml') || !zip.file(ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml')) throw new Error() } catch { throw new DocHubError('Invalid Office document.') } }
  const signers = (Array.isArray(input.signers) ? input.signers : []).filter((s: any) => String(s?.name || '').trim() || String(s?.email || '').trim()).map((s: any) => ({ name: String(s.name || '').trim().slice(0,100), email: String(s.email || '').trim().toLowerCase(), label: String(s.label || 'Signatory').trim().slice(0,100) }))
  if (!signers.length || signers.length > 12 || signers.some((s: any) => !s.name || s.email.length > 254 || !email.test(s.email))) throw new DocHubError('Enter a name and valid email for each signatory (up to 12). Leave unused slots completely blank.')
  if (new Set(signers.map((s: any) => s.email)).size !== signers.length) throw new DocHubError('Use one signatory per email address.')
  const followUpDays = Number(input.followUpDays || 0)
  if (!Number.isInteger(followUpDays) || followUpDays < 0 || followUpDays > 90) throw new DocHubError('Follow-up must be from 0 to 90 days.')
  const title = String(input.title || fileName).trim().slice(0,180)
  const fingerprint = createHash('sha256').update(bytes).update(JSON.stringify({ signers, title, kind: input.kind, taskId: input.taskId || '', clientId: input.clientId || '', sequential: !!input.sequential, followUpDays })).digest('hex')
  return { id: input.id, kind: input.kind, title, fileName, mimeType: types[ext], fileData: encoded, signers, sequential: !!input.sequential, followUpDays, taskId: String(input.taskId || ''), clientId: String(input.clientId || ''), fingerprint }
}
function addEvent(doc: any, key: string, message: string, complete = false) {
  doc.events ||= []
  if (doc.events.some((e: any) => e.key === key)) return
  doc.events.push({ id: `dochub:${doc.id}:${key}`, key, message, createdAt: new Date().toISOString(), complete })
}
export function publicDocument(doc: any) {
  const { fileData: _file, uploadKey: _key, fingerprint: _fingerprint, ...safe } = doc
  return safe
}
export function applyDocumentToWorkspace(state: any, doc: any) {
  const task = (state.items || []).find((i: any) => i.id === doc.taskId)
  const events = doc.events || [], notifications = [...(state.notifications || [])]
  const completion = doc.completionNotified ? undefined : events.find((e: any) => e.complete)
  if (completion) {
    const recipients = (state.accounts || []).filter((u: any) => u.status === 'Active' && u.role !== 'Viewer' && (u.id === doc.createdBy || u.id === task?.assignedToUserId || u.role === 'Administrator'))
    for (const u of recipients) {
      const dedupeKey = `dochub-complete:${doc.id}:${u.id}`
      if (!notifications.some((n: any) => n.dedupeKey === dedupeKey)) notifications.unshift({ id: randomUUID(), dedupeKey, recipientUserId: u.id, createdAt: completion.createdAt, type: 'signature_completed', scope: u.id === doc.createdBy || u.id === task?.assignedToUserId ? 'personal' : 'team', severity: 'success', title: 'Signature complete', message: `${doc.title} has been fully signed.`, taskId: task?.id, parentTaskId: task?.parentTaskId, clientId: doc.clientId || undefined, projectId: doc.projectId || undefined, documentId: doc.id, actorName: 'DocHub', actorUserId: 'system:dochub' })
    }
  }
  let items = state.items
  if (task) {
    const comments = [...(task.comments || [])]
    for (const e of events.filter((event: any) => !(doc.mirroredEventKeys || []).includes(event.key))) if (!comments.some((c: any) => c.id === e.id)) comments.push({ id: e.id, text: `${doc.title}: ${e.message}`, createdAt: e.createdAt, createdBy: 'system:dochub', createdByName: 'DocHub', kind: 'System', eventType: 'DOCHUB', documentId: doc.id })
    const links = [...(task.docHubDocuments || []).filter((d: any) => d.id !== doc.id), { id: doc.id, title: doc.title, status: doc.status, signed: doc.signers.filter((s: any) => !s.removed && (s.signedAt || s.status === 'FINALIZED')).length, total: doc.signers.filter((s: any) => !s.removed).length, documentUrl: doc.documentUrl || '' }]
    // Existing follow-up dates and task status remain under the user's control.
    const followUpDate = !task.followUpDate && !archivedWorkReason(state, task) && doc.followUpDate && !terminal.has(doc.status) ? doc.followUpDate : task.followUpDate
    const updated = { ...task, comments: comments.slice(-500), docHubDocuments: links, followUpDate }
    items = state.items.map((i: any) => i.id === task.id ? updated : i)
  }
  const next = { ...state, items, notifications }
  return { next, changed: JSON.stringify(next) !== JSON.stringify(state) }
}

export function createDocHubService(deps: Deps) {
  const { db } = deps
  const locks = new Map<string,Promise<any>>()
  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) || Promise.resolve()
    const job = prior.catch(() => undefined).then(fn); locks.set(key, job)
    try { return await job } finally { if (locks.get(key) === job) locks.delete(key) }
  }
  function check(error: any) { if (error) throw new DocHubError('DocHub storage is unavailable. Apply supabase/schema-v10-dochub.sql and check the database connection.', 503) }
  function database() { if (!db) throw new DocHubError('Supabase is not configured.',503); return db }
  async function account(tenant: string) { const r = await database().from('tenant_dochub_accounts').select('*').eq('tenant_id',tenant).maybeSingle(); check(r.error); return r.data }
  async function active(tenant: string) { const a = await account(tenant); if (!a?.enabled) throw new DocHubError('Ask your account Administrator to configure and enable DocHub in Settings.',409); return apiClient(decryptSecret(a.encrypted_api_key, tenant, 'dochub'), deps.request) }
  async function load(tenant: string,id: string) { const r = await database().from('tenant_dochub_documents').select('data').eq('tenant_id',tenant).eq('id',id).maybeSingle(); check(r.error); if (!r.data) throw new DocHubError('Document not found.',404); return r.data.data }
  async function save(tenant: string,doc: any) { doc.updatedAt = new Date().toISOString(); const r = await database().from('tenant_dochub_documents').upsert({ tenant_id:tenant,id:doc.id,document_id:doc.documentId || null,data:doc,updated_at:doc.updatedAt },{onConflict:'tenant_id,id'}); check(r.error) }
  async function list(tenant: string) { const r = await database().from('tenant_dochub_documents').select('data').eq('tenant_id',tenant).order('updated_at',{ascending:false}).limit(500); check(r.error); return (r.data || []).map((r: any) => r.data) }
  async function mirror(tenant: string,doc: any) {
    for (let attempt=0;attempt<4;attempt++) {
      const current = (await deps.load(tenant)).data
      if (!current) return
      const {next,changed} = applyDocumentToWorkspace(current,doc)
      if (!changed && (doc.mirroredEventKeys || []).length === (doc.events || []).length) return
      try {
        if(changed) await deps.commit(tenant,next,null,'dochub-update',current)
        doc.mirroredEventKeys=(doc.events || []).map((e: any)=>e.key)
        if((doc.events || []).some((e: any)=>e.complete))doc.completionNotified=true
        await save(tenant,doc);return
      } catch(e) { if (!(e instanceof LifecycleError) || attempt===3) throw e }
    }
  }
  async function refresh(tenant: string,id: string,force=false) {
    return locked(`${tenant}:${id}`,async()=> {
      const doc = await load(tenant,id)
      if (!force && Date.now()-Date.parse(doc.checkedAt || '')<15_000) return doc
      const org = await deps.organizationById(tenant)
      if (!org || org.status !== 'Active') throw new DocHubError('This account is unavailable.',403)
      const api = await active(tenant)
      doc.error = ''; doc.checkedAt = new Date().toISOString()
      try {
        if (!doc.documentId && !doc.importId) {
          if (doc.importAttemptAt) { doc.status='REVIEW_REQUIRED'; doc.error='The import response was lost. Check DocHub, then link the existing document below. Automatic re-upload is paused to avoid duplicates.' }
          else {
            if (!doc.uploadKey) { doc.uploadKey = await api.upload(Buffer.from(doc.fileData,'base64'),doc.fileName,doc.mimeType); await save(tenant,doc) }
            doc.importAttemptAt = new Date().toISOString(); await save(tenant,doc)
            const imported = await api.call('/documents/imports','POST',{ s3DirectKey:doc.uploadKey,title:doc.title,privacy:'PRIVATE' })
            if (!imported.id) throw new DocHubError('DocHub did not return an import ID.',502)
            doc.importId = String(imported.id); doc.status='IMPORTING'; delete doc.fileData; delete doc.uploadKey; await save(tenant,doc)
          }
        }
        if (!doc.documentId && doc.importId) {
          const imported = await api.call(`/documents/imports/${docHubId(doc.importId)}`)
          if (imported.status === 'completed' && imported.documentId) {
            doc.documentId=String(imported.documentId);doc.status='UPLOADED';addEvent(doc,'uploaded','Uploaded to DocHub. Preparing recipients; no invitations sent.');await save(tenant,doc)
          } else if (['failed','password_required'].includes(imported.status)) { doc.status='IMPORT_FAILED';doc.error=imported.status === 'password_required' ? 'DocHub requires an unlocked PDF. Generate an unlocked document and start a new preparation.' : `DocHub could not import this file (${String(imported.error?.code || 'IMPORT_FAILED').replace(/[^A-Z_]/g,'')}). Start a new preparation after correcting the file.` }
          else { doc.status='IMPORTING'; if (Date.now()-Date.parse(doc.createdAt)>15*60_000) doc.error='Conversion is taking longer than expected. The existing import is preserved; refresh later or check DocHub.' }
        }
        if (doc.documentId) {
          const remoteDocument = await api.call(`/documents/${docHubId(doc.documentId)}`)
          if (remoteDocument.isTemplate) throw new DocHubError('A regular document is required; templates are not supported.',409)
          doc.documentUrl=docHubUrl(remoteDocument.fullUrl) || docHubUrl(`https://dochub.com/d/${docHubId(doc.documentId)}`)
          doc.signRequestId=remoteDocument.signRequestId || doc.signRequestId
          if (!doc.signRequestId && !doc.rolesPrepared) {
            const existing=await api.call(`/document-roles?filter[documentId]=${docHubId(doc.documentId)}`)
            const roles=Array.isArray(existing.data)?existing.data:[]
            for (let index=0;index<doc.signers.length;index++) {
              const signer=doc.signers[index]
              const found=roles.find((r: any)=>String(r.email || '').toLowerCase()===signer.email)
              const role=found || await api.call('/document-roles','POST',{documentId:doc.documentId,name:signer.name,email:signer.email,canFreeEdit:false,receivesFinalCopy:true,...(doc.sequential?{queuePosition:index+1}:{})})
              if (!role.id) throw new DocHubError('DocHub did not return the recipient role.',502)
              signer.roleId=String(role.id);await save(tenant,doc)
            }
            doc.rolesPrepared=true;await save(tenant,doc)
          }
          if (!doc.signRequestId && !doc.draftAttempted) {
            // Persist intent before the remote mutation; reconciliation discovers a request if the response is lost.
            doc.draftAttempted=true;await save(tenant,doc)
            try {
              const draft=await api.call('/sign-requests','POST',draftPacket(doc.documentId,doc.signers,doc.sequential,doc.title))
              if (!draft.id) throw new DocHubError('DocHub did not return a draft ID.',502)
              doc.signRequestId=String(draft.id)
              if (draft.status !== 'PREPARING') throw new DocHubError('DocHub returned a non-draft state. Open DocHub to review the request.',502)
            } catch(e) {
              if (!(e instanceof DocHubError) || e.providerStatus !== 422) throw e
              // Some accounts require assigned fields even for PREPARING. Keep ordinary document roles unsent.
              doc.setupNote='Recipients are saved in DocHub. Place and assign signature fields, then send there. DocHub requires fields before it will create the signing draft.'
            }
          }
          if (doc.signRequestId) {
            const remote=await api.call(`/sign-requests/${docHubId(doc.signRequestId)}?include=document,signers.user`)
            doc.status=signingStatus(remote);doc.compiledPdfId=remote.compiledPdfId || '';doc.remoteStatus=String(remote.status || '')
            if (Array.isArray(remote.signersData)) doc.signers=remote.signersData.map((s: any)=>({id:s.id,name:s.name || s.email || 'Signatory',email:s.email || '',roleId:doc.signers.find((old: any)=>old.email===s.email)?.roleId,status:s.status,viewedAt:s.viewedAt || null,signedAt:s.signedAt || null,removed:!!s.removed,queuePosition:s.queuePosition || null}))
            for (const signer of doc.signers) {
              if (signer.viewedAt) addEvent(doc,`viewed:${signer.id}`,`${signer.name} viewed the document (${signer.viewedAt}).`)
              if (signer.signedAt || signer.status==='FINALIZED') addEvent(doc,`signed:${signer.id}`,`${signer.name} signed the document${signer.signedAt?` (${signer.signedAt})`:''}.`)
            }
          } else doc.status='SETUP_REQUIRED'
          if (['PREPARING','SETUP_REQUIRED'].includes(doc.status)) {
            const fields=await api.call(`/formfields?filter[documentId]=${docHubId(doc.documentId)}`)
            doc.fields=Array.isArray(fields.data)?fields.data.map((f: any)=>({id:f.id,roleId:f.documentRoleId || '',type:f.ffType,required:!!f.isRequired,pageId:f.pageId})):[]
            doc.fieldsReady=doc.signers.length>0 && doc.signers.every((s: any)=>doc.fields.some((f: any)=>f.roleId===s.roleId && f.type==='dhSignature' && f.required))
            if (doc.fieldsReady) doc.status='READY_TO_REVIEW'
          }
          if (doc.signRequestId || !['PREPARING','SETUP_REQUIRED'].includes(doc.status)) delete doc.setupNote
          if (['SENT','VIEWED','PARTIALLY_SIGNED'].includes(doc.status) && !doc.sentObservedAt) {
            doc.sentObservedAt=new Date().toISOString()
            if (doc.followUpDays) {const day=new Date();day.setUTCDate(day.getUTCDate()+doc.followUpDays);doc.followUpDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(day)}
          }
          const messages: Record<string,string>={SETUP_REQUIRED:'Signer emails prepared. Signature setup required; no invitations sent.',PREPARING:'Unsent signing draft created. Open DocHub to place and assign signature fields.',READY_TO_REVIEW:'Required signature fields found for all recipients. Review and send in DocHub.',SENT:'Sent for signature in DocHub.',VIEWED:'Awaiting signatures; the document has been viewed.',PARTIALLY_SIGNED:'Some signatories have signed. Remaining signatures are pending.',COMPLETED:'Signature complete. All required signatories have finished. The task remains open until you choose to complete it.',REJECTED:'A signatory rejected the request.',VOIDED:'The signature request was voided.',EXPIRED:'The signature request expired.',BOUNCE:'A signature invitation could not be delivered.',ERROR:'DocHub reported a signing error.'}
          if (messages[doc.status]) addEvent(doc,`status:${doc.status}`,messages[doc.status],doc.status==='COMPLETED')
        }
      } catch(e) { doc.error=e instanceof DocHubError ? e.message : 'Document preparation could not finish. Refresh to continue the existing preparation.'; if(!doc.documentId && !doc.importId)doc.status=doc.importAttemptAt?'REVIEW_REQUIRED':'UPLOAD_FAILED' }
      await save(tenant,doc)
      try { await mirror(tenant,doc) } catch { doc.error=[doc.error,'Task updates are pending synchronization; refresh to retry.'].filter(Boolean).join(' ');await save(tenant,doc) }
      return doc
    })
  }
  async function prepare(tenant: string,user: any,input: any) {
    const clean=validatePreparation(input)
    await active(tenant)
    await locked(`${tenant}:${clean.id}`,async()=>{
      let existing:any
      try{existing=await load(tenant,clean.id)}catch(e){if(!(e instanceof DocHubError)||e.status!==404)throw e}
      if(existing){if(existing.fingerprint!==clean.fingerprint)throw new DocHubError('This preparation ID already belongs to another document revision.',409);return}
      const current=(await deps.load(tenant)).data
      const task=clean.taskId?(current?.items || []).find((i:any)=>i.id===clean.taskId):undefined
      if(clean.taskId&&!task)throw new DocHubError('Select an existing task or subtask in this account.',404)
      if(task){if(!user.modules?.some((m:string)=>['items','action','clients','projects'].includes(m)))throw new DocHubError('Task access is required to link this document.',403);const reason=archivedWorkReason(current,task);if(reason)throw new DocHubError(reason,409)}
      const ctx=task?workContext(current,task):{clientId:clean.clientId,projectId:''}
      if(clean.clientId&&task&&ctx.clientId!==clean.clientId)throw new DocHubError('The linked task belongs to a different client.')
      if(ctx.clientId&&!(current?.clients||[]).some((c:any)=>c.id===ctx.clientId&&!c.archived))throw new DocHubError('Select an active client in this account.')
      const creatorName=String(user.name || user.username || 'User').trim().slice(0,120) || 'User'
      const doc={...clean,clientId:ctx.clientId || '',projectId:ctx.projectId || '',createdBy:user.id,createdByName:creatorName,createdAt:new Date().toISOString(),status:'UPLOADING',events:[]}
      addEvent(doc,'generated',`Generated by ${creatorName} and queued for DocHub draft preparation.`);await save(tenant,doc)
    })
    return refresh(tenant,clean.id,true)
  }
  async function scan() {
    if(!db)return
    const rows=await db.from('tenant_dochub_accounts').select('tenant_id').eq('enabled',true)
    if(rows.error)return
    for(const a of rows.data || []){
      const org=await deps.organizationById(a.tenant_id).catch(()=>null);if(!org||org.status!=='Active')continue
      for(const doc of await list(a.tenant_id).catch(()=>[])) {
        if(terminal.has(doc.status)){ await locked(`${a.tenant_id}:${doc.id}`,async()=>mirror(a.tenant_id,await load(a.tenant_id,doc.id))).catch(()=>undefined);continue }
        if(['REVIEW_REQUIRED','IMPORT_FAILED','UPLOAD_FAILED'].includes(doc.status)&&!doc.error?.includes('synchronization'))continue
        await refresh(a.tenant_id,doc.id).catch(()=>undefined)
      }
    }
  }
  return {account,active,load,save,list,mirror,prepare,refresh,scan,locked,check}
}

export function registerDocHubRoutes(app:Express,deps:Deps,service=createDocHubService(deps)) {
  const wrap=(fn:(req:Request,res:Response)=>Promise<any>):RequestHandler=>async(req,res)=>{try{await fn(req,res)}catch(e){res.status(e instanceof DocHubError?e.status:503).json({error:e instanceof DocHubError?e.message:'DocHub is unavailable. Check the account settings and database migration.'})}}
  const guard=(admin=false):RequestHandler=>async(req,res,next)=>{
    const user=(req as any).authUser
    try{const org=await deps.organizationById(user.organizationId);if(!org||org.status!=='Active')throw new DocHubError('This account is unavailable.',403)
      if(admin?(user.role!=='Administrator'||!user.modules.includes('settings')):!user.modules?.some((m:string)=>['documents','items','action','clients','projects'].includes(m)))throw new DocHubError('Your role does not have access to this DocHub action.',403)
      res.setHeader('Cache-Control','no-store');next()
    }catch(e){res.status(e instanceof DocHubError?e.status:503).json({error:e instanceof Error?e.message:'Account unavailable.'})}
  }
  const limiter=rateLimit({windowMs:60_000,limit:120,standardHeaders:true,legacyHeaders:false,message:{error:'Too many DocHub requests. Wait a minute and retry.'}})
  const scope=[deps.requireAuth,deps.requireTenant,guard(),limiter],admins=[deps.requireAuth,deps.requireTenant,guard(true),limiter]
  const tenant=(req:Request)=>(req as any).authUser.organizationId as string
  const write=(req:Request)=>{const u=(req as any).authUser;if(u.role==='Viewer'||!u.modules?.includes('documents'))throw new DocHubError('Document Creation write access is required.',403);return u}
  const webhookUrl=(id:string)=>{try{const u=new URL(process.env.APP_BASE_URL || '');if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return '';return `${u.origin}/api/webhooks/dochub/${id}`}catch{return ''}}
  app.get('/api/account/dochub',...admins,wrap(async(req,res)=>{const a=await service.account(tenant(req));let encryptionReady=true;try{encryptionKey()}catch{encryptionReady=false}res.json({configured:!!a,enabled:!!a?.enabled,maskedKey:a?`••••••••${a.key_suffix}`:'',verifiedAt:a?.verified_at,webhookConfigured:!!a?.encrypted_webhook_secret,webhookRegistered:!!a?.webhook_id,webhookUrl:webhookUrl(tenant(req)),encryptionReady})}))
  app.put('/api/account/dochub',...admins,wrap(async(req,res)=>{
    const id=tenant(req),previous=await service.account(id),key=String(req.body?.apiKey || '').trim(),webhookSecret=String(req.body?.webhookSecret || '').trim()
    if(!previous&&!key)throw new DocHubError('Enter the DocHub API key.')
    if(key&&(key.length<20||key.length>4096||/\s/.test(key)))throw new DocHubError('Enter a valid DocHub API key.')
    if(webhookSecret&&(webhookSecret.length<16||webhookSecret.length>4096||/\s/.test(webhookSecret)))throw new DocHubError('Enter a valid webhook signing secret.')
    const encrypted_api_key=key?encryptSecret(key,id,'dochub'):previous.encrypted_api_key
    if(key)await apiClient(key,deps.request).call('/documents?perPage=1')
    const row={...previous,tenant_id:id,encrypted_api_key,key_suffix:key?key.slice(-4):previous.key_suffix,enabled:req.body.enabled!==false,encrypted_webhook_secret:webhookSecret?encryptSecret(webhookSecret,id,'dochub-webhook'):previous?.encrypted_webhook_secret || null,verified_at:key?new Date().toISOString():previous?.verified_at,updated_at:new Date().toISOString()}
    const r=await deps.db.from('tenant_dochub_accounts').upsert(row);service.check(r.error);res.json({ok:true})
  }))
  app.post('/api/account/dochub/test',...admins,wrap(async(req,res)=>{const api=await service.active(tenant(req));await api.call('/documents?perPage=1');res.json({ok:true,message:'API key and document read access verified. Upload and signing permissions are checked during preparation.'})}))
  app.post('/api/account/dochub/webhook',...admins,wrap(async(req,res)=>{
    const id=tenant(req),url=webhookUrl(id);if(!url)throw new DocHubError('Set APP_BASE_URL to your public HTTPS tracker URL on the server first.')
    const a=await service.account(id);if(a?.webhook_id)throw new DocHubError('A webhook is already registered. Manage or rotate it in the DocHub developer portal and save its new secret here.',409)
    const api=await service.active(id)
    const remote=await api.call('/webhooks','POST',{name:'BA Client Ops Tracker',url,events:['document.status_changed','sign_request.created','sign_request.voided','signer.finalized','signer.rejected']})
    if(!remote.secret||!remote.id)throw new DocHubError('Webhook registration did not return a signing secret. Manage it in DocHub and enter the secret here.',502)
    const r=await deps.db.from('tenant_dochub_accounts').update({encrypted_webhook_secret:encryptSecret(remote.secret,id,'dochub-webhook'),webhook_id:remote.id,webhook_url:url,updated_at:new Date().toISOString()}).eq('tenant_id',id);if(r.error)throw new DocHubError('The webhook was created but its secret could not be saved. Open the DocHub developer portal, rotate that webhook secret, and save it here before trying registration again.',503);res.json({ok:true})
  }))
  app.get('/api/dochub/status',...scope,wrap(async(req,res)=>{const a=await service.account(tenant(req));res.json({configured:!!a,enabled:!!a?.enabled,webhookConfigured:!!a?.encrypted_webhook_secret})}))
  app.get('/api/dochub/documents',...scope,wrap(async(req,res)=>{const id=tenant(req);let documents=await service.list(id);if(req.query.taskId)documents=documents.filter((d:any)=>d.taskId===req.query.taskId);let names=new Map<string,string>();try{const state=(await deps.load(id)).data;names=new Map((state?.accounts || []).map((u:any)=>[String(u.id),String(u.name || u.username || 'User')]))}catch{}res.json({documents:documents.map((doc:any)=>publicDocument({...doc,createdByName:doc.createdByName || names.get(String(doc.createdBy || '')) || (doc.createdBy?'Former user':'System')}))})}))
  app.post('/api/dochub/prepare',...scope,wrap(async(req,res)=>{const u=write(req);res.json({document:publicDocument(await service.prepare(tenant(req),u,req.body))})}))
  app.post('/api/dochub/documents/:id/refresh',...scope,wrap(async(req,res)=>{res.json({document:publicDocument(await service.refresh(tenant(req),String(req.params.id)))})}))
  app.post('/api/dochub/documents/:id/recover',...scope,wrap(async(req,res)=>{
    write(req);const id=tenant(req),key=String(req.params.id),documentId=String(req.body?.documentId || '').trim()
    if(!/^[a-zA-Z0-9_-]{3,120}$/.test(documentId))throw new DocHubError('Enter the existing DocHub document ID.')
    await service.locked(`${id}:${key}`,async()=>{const doc=await service.load(id,key);if(doc.documentId)throw new DocHubError('This preparation already has a DocHub document.',409)
      const api=await service.active(id),remote=await api.call(`/documents/${docHubId(documentId)}`);if(remote.isTemplate)throw new DocHubError('Choose a regular document.')
      doc.documentId=documentId;doc.status='UPLOADED';delete doc.fileData;delete doc.uploadKey;await service.save(id,doc)})
    res.json({document:publicDocument(await service.refresh(id,key,true))})
  }))
  app.get('/api/dochub/documents/:id/pdf',...scope,wrap(async(req,res)=>{const doc=await service.load(tenant(req),String(req.params.id));if(doc.status!=='COMPLETED'||!doc.documentId)throw new DocHubError('The signed PDF is available after completion.',409)
    const api=await service.active(tenant(req)),remote=await api.call(doc.compiledPdfId?`/compiled-pdfs/${docHubId(doc.compiledPdfId)}/download-url?documentId=${docHubId(doc.documentId)}`:`/documents/${docHubId(doc.documentId)}/pdf-url`)
    res.redirect(302,storageUrl(remote.url))
  }))
  let scanning=false
  const timer=setInterval(()=>{if(scanning)return;scanning=true;void service.scan().catch(()=>undefined).finally(()=>{scanning=false})},60_000);timer.unref()
  return service
}

// Register BEFORE express.json(): the HMAC requires exact raw bytes.
export function registerDocHubWebhook(app:Express,deps:Deps,service:ReturnType<typeof createDocHubService>){
  app.post('/api/webhooks/dochub/:tenant',express.raw({type:'application/json',limit:'256kb'}),async(req,res)=>{
    try{
      const tenant=String(req.params.tenant);if(!uuid.test(tenant)||!Buffer.isBuffer(req.body))return void res.sendStatus(400)
      const account=await service.account(tenant)
      if(!account?.enabled||!account?.encrypted_webhook_secret)return void res.sendStatus(401)
      const secret=decryptSecret(account.encrypted_webhook_secret,tenant,'dochub-webhook')
      if(!verifyDocHubWebhook(req.body,req.get('X-DocHub-Timestamp'),req.get('X-DocHub-Signature-256'),secret))return void res.sendStatus(401)
      const event=JSON.parse(req.body.toString('utf8'))
      if(event.id!==req.get('X-DocHub-Event-Id')||event.type!==req.get('X-DocHub-Event'))return void res.sendStatus(400)
      const org=await deps.organizationById(tenant);if(!org||org.status!=='Active')return void res.sendStatus(403)
      if(event.type==='webhook.ping')return void res.sendStatus(204)
      // The signed event is a refresh signal, never an authority to overwrite status or select another tenant.
      const documentId=String(event.data?.document?.id || ''),requestId=String(event.data?.sign_request?.id || '')
      const docs=await service.list(tenant)
      const matched=docs.filter((d:any)=>(documentId&&d.documentId===documentId)||(requestId&&d.signRequestId===requestId))
      for(const doc of matched){const updated=await service.refresh(tenant,doc.id,true);if(updated.error)return void res.sendStatus(503)}
      res.sendStatus(204)
    }catch{res.sendStatus(503)}
  })
}
