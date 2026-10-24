import rateLimit from 'express-rate-limit'
import express, { type Express, type Request, type Response, type RequestHandler } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import PizZip from 'pizzip'
import { encryptSecret, decryptSecret, encryptionKey, IntegrationError } from './tenant-integrations'
import { apiClient, DocHubError, docHubId, docHubUrl, storageUrl, verifyDocHubWebhook, draftPacket, signingStatus } from './dochub-api'
import { archivedWorkReason, workContext, LifecycleError } from '../../src/features/tasks/lifecycle'
import type { DriveFiler } from './google-drive'
type Deps = { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; organizationById: (id: string) => Promise<any>; load: (id: string) => Promise<any>; commit: (id: string, state: any, actor: any, reason: string, before: any, sync?: boolean) => Promise<any>; request?: typeof fetch
  /** Set once Google Drive is wired; a fully signed PDF is then filed under its task. */
  driveFiler?: DriveFiler }
const terminal = new Set(['DONE','COMPLETE','COMPLETED','REJECTED','VOID','VOIDED','EXPIRED'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const types: Record<string,string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
const SIGNED_PDF_MAX_BYTES = 25 * 1024 * 1024
const DRIVE_MAX_ATTEMPTS = 6

export function signedPdfFileName(doc: any): string {
  const source = String(doc?.fileName || doc?.title || 'signed-document').trim()
  const baseName = (source.split(/[\\/]/).pop() || 'signed-document')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.(?:docx|xlsx|pdf|zip)$/i, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 170)
  return `${baseName || 'signed-document'}.pdf`
}

function signedPdfContentDisposition(fileName: string): string {
  const fallback = fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/'/g, '%27')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
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

const documentFields = ['id','kind','title','fileName','taskId','clientId','projectId','status','documentUrl','documentId','signRequestId','error','setupNote','createdAt','createdBy','createdByName','updatedAt','checkedAt','followUpDate','signers','events','driveFile','driveNote','driveError']
const documentProjection = documentFields.map(field => `${field}:data->${field}`).join(',')
export function documentHistoryRevision(rows: any[]) {
  return createHash('sha256').update(JSON.stringify(rows.map(row => [row.id,row.updated_at]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex')
}
function mirrorProjection(doc: any) {
  return createHash('sha256').update(JSON.stringify({id:doc.id,taskId:doc.taskId,clientId:doc.clientId,projectId:doc.projectId,title:doc.title,status:doc.status,documentUrl:doc.documentUrl,followUpDate:doc.followUpDate,signers:(doc.signers || []).map((signer:any)=>[signer.id,signer.removed,Boolean(signer.signedAt || signer.status==='FINALIZED')]),events:doc.events || []})).digest('hex')
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
  function documentQuery(tenant: string,projection: string,taskId?: string) {
    let query=database().from('tenant_dochub_documents').select(projection).eq('tenant_id',tenant)
    if(taskId)query=query.eq('data->>taskId',taskId)
    return query.order('updated_at',{ascending:false}).limit(500)
  }
  async function list(tenant: string,taskId?: string) {const r=await documentQuery(tenant,documentProjection+',updated_at',taskId);check(r.error);return {documents:(r.data || []).map(({updated_at,...document}:any)=>document),revision:documentHistoryRevision(r.data || [])}}
  async function revision(tenant: string,taskId?: string) {const r=await documentQuery(tenant,'id,updated_at',taskId);check(r.error);return documentHistoryRevision(r.data || [])}
  async function mirror(tenant: string,doc: any) {
    const projection=mirrorProjection(doc)
    if(doc.mirroredProjection===projection && !doc.error?.includes('synchronization'))return
    for (let attempt=0;attempt<4;attempt++) {
      const current = (await deps.load(tenant)).data
      if (!current) return
      const {next,changed} = applyDocumentToWorkspace(current,doc)
      if (!changed && (doc.mirroredEventKeys || []).length === (doc.events || []).length) {doc.mirroredProjection=projection;await save(tenant,doc);return}
      try {
        if(changed) await deps.commit(tenant,next,null,'dochub-update',current)
        doc.mirroredProjection=projection
        doc.mirroredEventKeys=(doc.events || []).map((e: any)=>e.key)
        if((doc.events || []).some((e: any)=>e.complete))doc.completionNotified=true
        await save(tenant,doc);return
      } catch(e) { if (!(e instanceof LifecycleError) || attempt===3) throw e }
    }
  }
  /** The signed PDF from DocHub. Used for the download link and for filing to Drive. */
  async function signedPdf(tenant: string,doc: any) {
    if(doc.status!=='COMPLETED'||!doc.documentId)throw new DocHubError('The signed PDF is available after completion.',409)
    const api=await active(tenant),remote=await api.call(doc.compiledPdfId?`/compiled-pdfs/${docHubId(doc.compiledPdfId)}/download-url?documentId=${docHubId(doc.documentId)}`:`/documents/${docHubId(doc.documentId)}/pdf-url`)
    const url=storageUrl(remote.url),request=deps.request || fetch
    let response:Awaited<ReturnType<typeof fetch>>
    try{response=await request(url,{method:'GET',headers:{Accept:'application/pdf'},redirect:'error',signal:AbortSignal.timeout(60_000)})}catch{throw new DocHubError('The signed PDF could not be downloaded from DocHub. Refresh the document and try again.',502)}
    if(!response.ok)throw new DocHubError('DocHub storage could not provide the signed PDF.',502,response.status)
    const announcedSize=Number(response.headers.get('content-length') || 0)
    if(announcedSize>SIGNED_PDF_MAX_BYTES)throw new DocHubError('The signed PDF is too large to download through the tracker.',413)
    const buffer=Buffer.from(await response.arrayBuffer())
    if(!buffer.length||buffer.length>SIGNED_PDF_MAX_BYTES||buffer.subarray(0,5).toString()!=='%PDF-')throw new DocHubError('DocHub returned an invalid signed PDF.',502)
    return {buffer,fileName:signedPdfFileName(doc)}
  }
  /**
   * File the fully signed PDF into the shared Google Drive, under the linked subtask (or task), or the
   * Client / Project folder when no task is linked. Never throws: the outcome is recorded on the document
   * so the signing record is not affected by a Drive problem, and it can be retried.
   */
  async function fileToDrive(tenant: string,doc: any) {
    const filer=deps.driveFiler
    if(!filer||doc.driveFile)return
    doc.driveError='';doc.driveNote=''
    try{
      if(!await filer.ready(tenant)){doc.driveNote='Google Drive is not connected, so the signed PDF was not filed. Ask your account Administrator to connect it in Settings, then choose Save to Google Drive.';return}
      const current=(await deps.load(tenant)).data
      const task=doc.taskId?(current?.items || []).find((i:any)=>i.id===doc.taskId):undefined
      if(!task&&!doc.clientId){doc.driveNote='Not filed to Google Drive: this document has no linked task or client. Link one when preparing a document so the signed PDF has a folder.';doc.driveSkipped=true;return}
      const {buffer,fileName}=await signedPdf(tenant,doc)
      let result:{file:any;path:string[]}
      try{result=await filer.file({tenantId:tenant,name:fileName,mimeType:'application/pdf',bytes:buffer,taskId:task?doc.taskId:undefined,clientId:doc.clientId || undefined,projectId:doc.projectId || undefined,user:null,commit:deps.commit,source:'dochub'})}
      catch(e){
        // The file is in Drive but the task vanished before it could be listed there: the file is still filed.
        if((e as any)?.code==='TASK_REMOVED'&&(e as any).file)result={file:(e as any).file,path:[]};else throw e
      }
      doc.driveFile={id:result.file.id,url:result.file.url,name:result.file.name,savedAt:result.file.savedAt || new Date().toISOString(),path:result.path.join(' / ')}
      doc.driveAttempts=0
      addEvent(doc,'drive:saved',`Signed PDF saved to Google Drive${result.path.length?`: ${result.path.join(' / ')}`:''}.`)
    }catch(e){
      doc.driveAttempts=(Number(doc.driveAttempts) || 0)+1
      doc.driveError=e instanceof DocHubError || e instanceof IntegrationError ? e.message : 'The signed PDF could not be saved to Google Drive. It will be retried; you can also choose Save to Google Drive.'
    }
  }
  async function refresh(tenant: string,id: string,force=false) {
    return locked(`${tenant}:${id}`,async()=> {
      const doc = await load(tenant,id)
      if (!force && Date.now()-Date.parse(doc.checkedAt || '')<15_000) return doc
      const previousStatus = doc.status
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
          if (!doc.signRequestId) {
            const existing=await api.call(`/document-roles?filter[documentId]=${docHubId(doc.documentId)}`)
            const roles=(Array.isArray(existing.data)?existing.data:[]).map((r:any)=>r.attributes?{id:r.id,...r.attributes}:r)
            const roleFor=(signer:any)=>roles.find((r:any)=>
              // Some DocHub responses contain roles beyond the requested filter.
              // An email can sign many DRFs; a role ID belongs to one document.
              String(r.documentId || r.document?.id || r.document_id || '')===String(doc.documentId) &&
              String(r.email || '').toLowerCase()===signer.email)
            if (doc.rolesPrepared && roles.some((r:any)=>r.documentId || r.document?.id || r.document_id) &&
              doc.signers.some((s:any)=>String(roleFor(s)?.id || '')!==String(s.roleId || ''))) {
              doc.rolesPrepared=false;doc.draftAttempted=false
              delete doc.setupNote
              addEvent(doc,'recipients-repaired','Recipient roles were rechecked for this document.');await save(tenant,doc)
            }
            if (!doc.rolesPrepared) {
              for (let index=0;index<doc.signers.length;index++) {
                const signer=doc.signers[index]
                const role=roleFor(signer) || await api.call('/document-roles','POST',{documentId:doc.documentId,name:signer.name,email:signer.email,canFreeEdit:false,receivesFinalCopy:true,...(doc.sequential?{queuePosition:index+1}:{})})
                if (!role.id) throw new DocHubError('DocHub did not return the recipient role.',502)
                signer.roleId=String(role.id);await save(tenant,doc)
              }
              doc.rolesPrepared=true;await save(tenant,doc)
            }
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
            if (Array.isArray(remote.signersData)) doc.signers=remote.signersData.map((s: any)=>{const previous=doc.signers.find((old: any)=>old.id===s.id || (old.email&&old.email===s.email));return {id:s.id,name:s.name || s.email || 'Signatory',email:s.email || '',roleId:previous?.roleId,status:s.status,viewedAt:s.viewedAt || null,signedAt:s.signedAt || null,removed:!!s.removed,queuePosition:s.queuePosition || null,notificationSentAt:previous?.notificationSentAt,notificationSentByName:previous?.notificationSentByName}})
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
      // Only documents that become fully signed while this feature is on are filed automatically; older ones can be filed with the button.
      if (doc.status==='COMPLETED' && previousStatus!=='COMPLETED' && !doc.driveFile) doc.driveAutoSave=true
      if (doc.status==='COMPLETED' && doc.driveAutoSave && !doc.driveFile && !doc.driveSkipped && (Number(doc.driveAttempts) || 0)<DRIVE_MAX_ATTEMPTS && !doc.error) await fileToDrive(tenant,doc)
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
  async function notifySigner(tenant: string,id: string,signerId: string,actor: any) {
    const refreshed=await refresh(tenant,id,true)
    if (refreshed.error) throw new DocHubError('The latest DocHub signer status could not be verified. Refresh the document successfully before sending a notification.',409)
    return locked(`${tenant}:${id}`,async()=>{
      const doc=await load(tenant,id)
      if (!['SENT','VIEWED','PARTIALLY_SIGNED'].includes(String(doc.status || '').toUpperCase()) || !doc.signRequestId) throw new DocHubError('Notifications are available only while the DocHub sign request is awaiting signatures.',409)
      const signer=(doc.signers || []).find((candidate:any)=>String(candidate.id || '')===signerId && !candidate.removed)
      if (!signer) throw new DocHubError('The selected signatory is no longer available.',404)
      const signerStatus=String(signer.status || '').toUpperCase()
      if (signer.signedAt || signerStatus==='FINALIZED') throw new DocHubError('This signatory has already signed the document.',409)
      if (signerStatus==='REJECTED') throw new DocHubError('This signatory rejected the request and cannot be reminded.',409)
      const last=Date.parse(String(signer.notificationSentAt || ''))
      if (Number.isFinite(last) && Date.now()-last < 180_000) throw new DocHubError('DocHub allows one reminder per signatory every 3 minutes. Wait before sending another.',429)
      const api=await active(tenant)
      try {
        await api.call(`/sign-requests/${docHubId(doc.signRequestId)}/resend-email`,'POST',{signerId:String(signer.id)})
      } catch (error) {
        if (error instanceof DocHubError && error.providerStatus===429) throw new DocHubError('DocHub rate-limited this signatory reminder. Wait at least 3 minutes before trying again.',429,429)
        if (error instanceof DocHubError && error.providerStatus===422) throw new DocHubError('DocHub rejected the reminder. The request may no longer be in progress, the signer may already be finalized or rejected, or a sequential signer may not be the current signer.',409,422)
        throw error
      }
      const senderName=String(actor?.name || actor?.username || 'User').trim().slice(0,120) || 'User'
      const sentAt=new Date().toISOString()
      signer.notificationSentAt=sentAt; signer.notificationSentByName=senderName
      addEvent(doc,`notification:${signer.id}:${sentAt}`,`${senderName} resent the DocHub signing invitation to ${signer.name || signer.email}.`)
      await save(tenant,doc)
      try { await mirror(tenant,doc) } catch { doc.error='DocHub resent the invitation, but its task activity entry is pending synchronization. Refresh to retry.';await save(tenant,doc) }
      return doc
    })
  }
  const scans=new Map<string,Promise<void>>(),lastScan=new Map<string,number>()
  async function scan(tenant: string,taskId?: string) {
    if(!db)return
    const key=`${tenant}:${taskId || ''}`
    if(scans.has(key))return scans.get(key)
    if(Date.now()-(lastScan.get(key) || 0)<120_000)return
    const work=(async()=>{
      const configured=await database().from('tenant_dochub_accounts').select('enabled').eq('tenant_id',tenant).maybeSingle();check(configured.error)
      if(!configured.data?.enabled)return
      const result=await documentQuery(tenant,'id,status:data->status,error:data->error,checkedAt:data->checkedAt,driveAutoSave:data->driveAutoSave,driveFile:data->driveFile,driveError:data->driveError,driveSkipped:data->driveSkipped,driveAttempts:data->driveAttempts',taskId);check(result.error)
      const pending=(result.data || []).filter((doc:any)=>{
        if(doc.error?.includes('synchronization'))return true
        // A signed document whose Drive filing failed is tried again, a few times.
        if(doc.status==='COMPLETED')return Boolean(doc.driveAutoSave && !doc.driveFile && !doc.driveSkipped && doc.driveError && (Number(doc.driveAttempts) || 0)<DRIVE_MAX_ATTEMPTS)
        return !terminal.has(doc.status) && !['REVIEW_REQUIRED','IMPORT_FAILED','UPLOAD_FAILED'].includes(doc.status)
      }).sort((a:any,b:any)=>String(a.checkedAt || '').localeCompare(String(b.checkedAt || ''))).slice(0,10)
      for(const doc of pending)await refresh(tenant,doc.id).catch(()=>undefined)
      lastScan.set(key,Date.now())
    })()
    scans.set(key,work)
    try{await work}finally{if(scans.get(key)===work)scans.delete(key)}
  }
  /** Manual filing of a signed document, also for ones signed before automatic filing existed. */
  async function saveToDrive(tenant: string,id: string) {
    return locked(`${tenant}:${id}`,async()=>{
      const doc=await load(tenant,id)
      if(doc.status!=='COMPLETED')throw new DocHubError('Only a fully signed document can be saved to Google Drive.',409)
      if(!deps.driveFiler)throw new DocHubError('Google Drive is not available.',503)
      if(!doc.driveFile){doc.driveSkipped=false;doc.driveAttempts=0;await fileToDrive(tenant,doc);await save(tenant,doc);try{await mirror(tenant,doc)}catch{}}
      return doc
    })
  }
  return {account,active,load,save,list,revision,mirror,prepare,refresh,notifySigner,scan,locked,check,signedPdf,saveToDrive}
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
  const notificationLimiter=rateLimit({windowMs:60_000,limit:10,standardHeaders:true,legacyHeaders:false,message:{error:'Too many reminder notifications. Wait a minute and retry.'}})
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
  app.get('/api/dochub/revision',...scope,wrap(async(req,res)=>{res.json({revision:await service.revision(tenant(req),String(req.query.taskId || '') || undefined)})}))
  app.post('/api/dochub/sync',...scope,wrap(async(req,res)=>{await service.scan(tenant(req),String(req.query.taskId || '') || undefined);res.json({ok:true})}))
  app.get('/api/dochub/documents',...scope,wrap(async(req,res)=>{
    const id=tenant(req),result=await service.list(id,String(req.query.taskId || '') || undefined)
    let names=new Map<string,string>()
    if(result.documents.some((doc:any)=>doc.createdBy && !doc.createdByName)){
      const users=await deps.db.from('app_users').select('id,name,username').eq('organization_id',id)
      if(!users.error)names=new Map((users.data || []).map((user:any)=>[String(user.id),String(user.name || user.username || 'User')]))
    }
    res.json({revision:result.revision,documents:result.documents.map((doc:any)=>publicDocument({...doc,signers:doc.signers || [],events:doc.events || [],createdByName:doc.createdByName || names.get(String(doc.createdBy || '')) || (doc.createdBy?'Former user':'System')}))})
  }))
  app.post('/api/dochub/prepare',...scope,wrap(async(req,res)=>{const u=write(req);res.json({document:publicDocument(await service.prepare(tenant(req),u,req.body))})}))
  app.post('/api/dochub/documents/:id/refresh',...scope,wrap(async(req,res)=>{res.json({document:publicDocument(await service.refresh(tenant(req),String(req.params.id)))})}))
  app.post('/api/dochub/documents/:id/signers/:signerId/notify',...scope,notificationLimiter,wrap(async(req,res)=>{
    const actor=write(req)
    const signerId=String(req.params.signerId || '').trim()
    if(!signerId || signerId.length>200)throw new DocHubError('Choose a valid signatory.')
    const document=await service.notifySigner(tenant(req),String(req.params.id),signerId,actor)
    res.json({ok:true,document:publicDocument(document),message:'DocHub reminder sent.'})
  }))
  app.post('/api/dochub/documents/:id/recover',...scope,wrap(async(req,res)=>{
    write(req);const id=tenant(req),key=String(req.params.id),documentId=String(req.body?.documentId || '').trim()
    if(!/^[a-zA-Z0-9_-]{3,120}$/.test(documentId))throw new DocHubError('Enter the existing DocHub document ID.')
    await service.locked(`${id}:${key}`,async()=>{const doc=await service.load(id,key);if(doc.documentId)throw new DocHubError('This preparation already has a DocHub document.',409)
      const api=await service.active(id),remote=await api.call(`/documents/${docHubId(documentId)}`);if(remote.isTemplate)throw new DocHubError('Choose a regular document.')
      doc.documentId=documentId;doc.status='UPLOADED';delete doc.fileData;delete doc.uploadKey;await service.save(id,doc)})
    res.json({document:publicDocument(await service.refresh(id,key,true))})
  }))
  app.get('/api/dochub/documents/:id/pdf',...scope,wrap(async(req,res)=>{const doc=await service.load(tenant(req),String(req.params.id));const {buffer,fileName}=await service.signedPdf(tenant(req),doc)
    res.setHeader('Content-Type','application/pdf')
    res.setHeader('Content-Length',String(buffer.length))
    res.setHeader('Cache-Control','private, no-store')
    res.setHeader('Content-Disposition',signedPdfContentDisposition(fileName))
    res.send(buffer)
  }))
  app.post('/api/dochub/documents/:id/drive',...scope,wrap(async(req,res)=>{
    write(req)
    res.json({document:publicDocument(await service.saveToDrive(tenant(req),String(req.params.id)))})
  }))
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
      const {documents:docs}=await service.list(tenant)
      const matched=docs.filter((d:any)=>(documentId&&d.documentId===documentId)||(requestId&&d.signRequestId===requestId))
      for(const doc of matched){const updated=await service.refresh(tenant,doc.id,true);if(updated.error)return void res.sendStatus(503)}
      res.sendStatus(204)
    }catch{res.sendStatus(503)}
  })
}
