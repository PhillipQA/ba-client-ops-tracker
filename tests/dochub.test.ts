import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import express from 'express'
import { encryptSecret, decryptSecret, IntegrationError } from '../server/integrations/tenant-integrations'
import { apiClient, DocHubError, docHubUrl, storageUrl, verifyDocHubWebhook, draftPacket, signingStatus } from '../server/integrations/dochub-api'
import { applyDocumentToWorkspace, createDocHubService, publicDocument, registerDocHubRoutes, registerDocHubWebhook, signedPdfFileName, validatePreparation } from '../server/integrations/dochub'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'
import { canNotifyDocHubSigner, docHubGuidance, isDocHubSignerSigned } from '../src/features/documents/dochub'
process.env.TENANT_INTEGRATION_MASTER_KEY='ab'.repeat(32)
const tenantA='11111111-1111-4111-8111-111111111111',tenantB='22222222-2222-4222-8222-222222222222'
const keyA='account-a-api-key-1234567890',keyB='account-b-api-key-1234567890'
const copy=(v:any)=>JSON.parse(JSON.stringify(v))
function database(){
 const tables=new Map<string,any[]>(),queries:any[]=[]
 const field=(row:any,key:string)=>key.split(/->>?/).reduce((value:any,part:string)=>value?.[part],row)
 return {tables,queries,from(table:string){if(!tables.has(table))tables.set(table,[]);let filters:any[]=[],op='select',payload:any,single=false,limit=Infinity,columns='*'
  const project=(row:any)=>columns==='*'?row:Object.fromEntries(columns.split(',').map(selection=>{const [alias,path]=selection.includes(':')?selection.split(':'):[selection,selection];return [alias,field(row,path)??null]}))
  const q:any={select(value='*'){columns=value;return q},eq(k:string,v:any){filters.push([k,v]);return q},maybeSingle(){single=true;return q},limit(v:number){limit=v;return q},order(){return q},upsert(v:any){op='upsert';payload=v;return q},update(v:any){op='update';payload=v;return q},then(resolve:any,reject:any){try{queries.push({table,columns,filters:copy(filters),op});const rows=tables.get(table)!,match=(r:any)=>filters.every(([k,v])=>field(r,k)===v);if(op==='upsert'){const old=rows.findIndex(r=>r.tenant_id===payload.tenant_id&&r.id===payload.id);if(old<0)rows.push(copy(payload));else rows[old]=copy(payload)}if(op==='update')rows.filter(match).forEach(r=>Object.assign(r,copy(payload)));const found=rows.filter(match).slice(0,limit).map(project);resolve({data:copy(single?found[0]||null:found),error:null})}catch(e){reject(e)}}};return q
 }}
}
function fixture(options:{rejectDraft?:boolean;lostImport?:boolean}={}){
 const db=database(),states=new Map<string,any>()
 const state={clients:[{id:'client',name:'Acme',status:'Active'}],projects:[],items:[{id:'task',title:'Create DRF',clientId:'client',status:'In Progress',waitingOn:'Me',followUpDate:'',assignedToUserId:'worker',comments:[]}],accounts:[{id:'admin',name:'Admin',status:'Active',role:'Administrator'},{id:'worker',name:'Worker',status:'Active',role:'Contributor'},{id:'viewer',status:'Active',role:'Viewer'}],notifications:[],taskSettings:{statuses:[{id:'open',label:'In Progress',closed:false},{id:'done',label:'Completed',closed:true}]}}
 states.set(tenantA,copy(state));states.set(tenantB,copy(state))
 for(const [id,key] of [[tenantA,keyA],[tenantB,keyB]])db.tables.set('tenant_dochub_accounts',[...(db.tables.get('tenant_dochub_accounts')||[]),{tenant_id:id,encrypted_api_key:encryptSecret(key,id,'dochub'),key_suffix:key.slice(-4),enabled:true,encrypted_webhook_secret:encryptSecret('webhook-test-secret-1234',id,'dochub-webhook')}])
 const calls:any[]=[],remote={status:'PREPARING',signRequestId:'',signRequests:{} as Record<string,string>,imports:0,signed:false,fields:false,roles:[] as any[],importComplete:false}
 const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
 const request:typeof fetch=async(url:any,init:any={})=>{
   const href=String(url);calls.push({url:href,method:init.method||'GET',headers:init.headers,body:typeof init.body==='string'?JSON.parse(init.body):init.body})
   if(href.startsWith('https://upload.dochub.com')){assert(!init.headers?.['X-API-Token']);assert(init.body instanceof FormData);assert(init.body.get('file') instanceof Blob);return new Response('',{status:204===200?200:201})}
   if(href.startsWith('https://bucket.s3.amazonaws.com/')){assert(!init.headers?.['X-API-Token']);assert.equal(init.headers?.Accept,'application/pdf');return new Response(Buffer.from('%PDF-1.7\nsigned fixture'),{status:200,headers:{'Content-Type':'application/pdf'}})}
   assert.equal(init.headers.Accept,'application/json');assert([keyA,keyB].includes(init.headers['X-API-Token']))
   const path=new URL(href).pathname,body=typeof init.body==='string'?JSON.parse(init.body):{}
   if(path==='/api/v2/documents')return response({data:[]})
   if(path.endsWith('/s3-direct'))return response({url:'https://upload.dochub.com/',fields:{key:'upload-key',policy:'private','Content-Type':'application/pdf'}},201)
   if(path==='/api/v2/documents/imports') {if(options.lostImport)throw new Error('socket lost');remote.imports++;return response({id:`import-${remote.imports}`,status:'processing'},202)}
   if(/^\/api\/v2\/documents\/imports\/import-\d+$/.test(path)){const n=path.split('-').pop();return response(remote.importComplete?{id:`import-${n}`,status:'completed',documentId:`doc${n}`}:{id:`import-${n}`,status:'processing'})}
   if(/^\/api\/v2\/documents\/doc\d+$/.test(path)){const id=path.split('/').pop()!;return response({id,isTemplate:false,fullUrl:`https://dochub.com/d/${id}`,signRequestId:remote.signRequests[id]||(id==='doc1'?remote.signRequestId:null)||null})}
   if(path==='/api/v2/document-roles'){if(init.method==='POST'){const role={id:`role${remote.roles.length+1}`,...body};remote.roles.push(role);return response(role,201)}return response({data:remote.roles})}
   if(path==='/api/v2/sign-requests'&&init.method==='POST') {assert.equal(body.preparingEnabled,true);assert.equal(body.documentRoles[0].canFreeEdit,false);if(options.rejectDraft)return response({error:'fields required'},422);const id=`sr${Object.keys(remote.signRequests).length+1}`;remote.signRequestId=id;remote.signRequests[body.documentId]=id;return response({id,status:'PREPARING'},201)}
   if(/^\/api\/v2\/sign-requests\/sr\d+$/.test(path))return response({id:path.split('/').pop(),status:remote.status,compiledPdfId:remote.signed?'pdf1':null,signersData:[{id:'signer1',name:'Signer',email:'signer@example.com',status:remote.signed?'FINALIZED':'CREATED',signedAt:remote.signed?'2026-09-24T12:00:00Z':null,viewedAt:remote.signed?'2026-09-24T11:00:00Z':null}]})
   if(/^\/api\/v2\/sign-requests\/sr\d+\/resend-email$/.test(path)&&init.method==='POST'){assert.equal(body.signerId,'signer1');return new Response(null,{status:204})}
   if(path==='/api/v2/compiled-pdfs/pdf1/download-url')return response({url:'https://bucket.s3.amazonaws.com/signed.pdf?signature=test'})
   if(path==='/api/v2/documents/doc1/pdf-url')return response({url:'https://bucket.s3.amazonaws.com/signed.pdf?signature=test'})
   if(path==='/api/v2/formfields')return response({data:remote.fields?[{id:'field1',documentRoleId:'role1',ffType:'dhSignature',isRequired:true}]:[]})
   throw new Error(`Unexpected operation ${init.method} ${path}`)
 }
 const deps:any={db,request,organizationById:async(id:string)=>({id,status:'Active'}),load:async(id:string)=>({data:copy(states.get(id))}),commit:async(id:string,next:any,_actor:any,_reason:any,before:any)=>{assert.deepEqual(states.get(id),before);assertLifecycleMutation(before,next,null);states.set(id,copy(next));return{}},requireAuth:(_req:any,_res:any,next:any)=>next(),requireTenant:(_req:any,_res:any,next:any)=>next()}
 return {db,states,calls,remote,deps,service:createDocHubService(deps),input:{id:randomUUID(),kind:'DRF',fileName:'DRF.pdf',fileData:Buffer.from('%PDF-1.7\nfixture').toString('base64'),taskId:'task',clientId:'client',followUpDays:3,signers:[{name:'Signer',email:'signer@example.com'}]},user:{id:'admin',name:'Admin',username:'Admin',role:'Administrator',modules:['documents','items'],organizationId:tenantA}}
}
test('encrypted credentials are bound to tenant and purpose',()=>{const c=encryptSecret(keyA,tenantA,'dochub');assert.equal(decryptSecret(c,tenantA,'dochub'),keyA);assert.throws(()=>decryptSecret(c,tenantB,'dochub'));assert.throws(()=>decryptSecret(c,tenantA,'dochub-webhook'))})
test('all draft packets are unsent and disallow free editing',()=>{const p=draftPacket('doc1',[{roleId:'r1',email:'a@example.com'}],true,'DRF');assert.equal(p.preparingEnabled,true);assert.equal(p.remindersEnabled,false);assert.equal(p.documentRoles[0].canFreeEdit,false);assert.equal(p.documentRoles[0].queuePosition,1)})
test('raw webhook signature rejects changed bytes, stale timestamps, missing headers and wrong tenant secret',()=>{const raw=Buffer.from('{ "id":"e1" }'),timestamp=String(Math.floor(Date.now()/1000)),secret='abcdef';const sig='dochub_v1='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');assert(verifyDocHubWebhook(raw,timestamp,sig,secret));assert(!verifyDocHubWebhook(Buffer.from('{"id":"e1"}'),timestamp,sig,secret));assert(!verifyDocHubWebhook(raw,timestamp,sig,'other'));assert(!verifyDocHubWebhook(raw,timestamp,sig,secret,Date.now()+301000));assert(!verifyDocHubWebhook(raw,undefined,undefined,secret))})
test('credentials never follow redirects or go to presigned storage',async()=>{let init:any;const c=apiClient(keyA,async(_u:any,i:any)=>{init=i;return new Response('{}')});await c.call('/documents');assert.equal(init.redirect,'error');assert.equal(docHubUrl('https://evil.example/doc'),'');assert.throws(()=>storageUrl('http://127.0.0.1'));assert.throws(()=>storageUrl('https://dochub.com.evil.example'));assert(storageUrl('https://bucket.s3.amazonaws.com/file'))})
test('input validates recipients, file type, size and duplicate addresses',()=>{const f=fixture();assert.equal(validatePreparation(f.input).kind,'DRF');assert.equal(validatePreparation({...f.input,fileName:'DRF-Acme-Main.pdf'}).title,'DRF-Acme-Main.pdf');for(const signers of [[],[{name:'A',email:'wrong'}],[{name:'A',email:'A@example.com'},{name:'B',email:'a@example.com'}]])assert.throws(()=>validatePreparation({...f.input,signers}));assert.throws(()=>validatePreparation({...f.input,fileData:Buffer.from('bad').toString('base64')}));assert.throws(()=>validatePreparation({...f.input,followUpDays:91}))})
test('upload -> async import -> unsent draft -> completed: single comment/notification, task stays open',async()=>{
 const f=fixture();let doc=await f.service.prepare(tenantA,f.user,f.input);assert.equal(doc.status,'IMPORTING');assert.equal(doc.createdByName,'Admin');assert(doc.events.some((e:any)=>e.message.includes('Generated by Admin')));f.remote.importComplete=true;doc=await f.service.refresh(tenantA,doc.id,true);assert.equal(doc.status,'PREPARING');assert.equal(f.remote.roles[0].email,'signer@example.com');assert(!f.calls.some(c=>c.url.endsWith('/send')))
 await f.service.prepare(tenantA,f.user,f.input);assert.equal(f.calls.filter(c=>c.url.endsWith('/documents/imports')&&c.method==='POST').length,1)
 f.remote.fields=true;doc=await f.service.refresh(tenantA,doc.id,true);assert.equal(doc.status,'READY_TO_REVIEW')
 f.remote.status='IN_PROGRESS';doc=await f.service.refresh(tenantA,doc.id,true);assert.equal(doc.status,'SENT');assert(f.states.get(tenantA).items[0].followUpDate)
 f.remote.status='FINALIZED';f.remote.signed=true;doc=await f.service.refresh(tenantA,doc.id,true);assert.equal(doc.status,'COMPLETED');const state=f.states.get(tenantA);assert.equal(state.items[0].status,'In Progress');assert.equal(state.notifications.length,2);assert.equal(state.items[0].comments.filter((c:any)=>c.text.includes('Signature complete')).length,1)
 await f.service.refresh(tenantA,doc.id,true);assert.equal(f.states.get(tenantA).notifications.length,2);assert.equal(f.states.get(tenantB).notifications.length,0)
 assert(!JSON.stringify(publicDocument(doc)).includes(f.input.fileData));assert(!('uploadKey' in publicDocument(doc)));assert(!('fingerprint' in publicDocument(doc)))
 await assert.rejects(()=>f.service.load(tenantB,doc.id),(e:any)=>e.status===404)
 await assert.rejects(()=>f.service.prepare(tenantA,f.user,{...f.input,signers:[{name:'Other',email:'other@example.com'}]}),(e:any)=>e.status===409)
})
test('a second DRF with the same signatories receives roles for its own document',async()=>{
 const f=fixture()
 const first=await f.service.prepare(tenantA,f.user,f.input)
 f.remote.importComplete=true
 await f.service.refresh(tenantA,first.id,true)
 const secondInput={...f.input,id:randomUUID(),fileData:Buffer.from('%PDF-1.7\nsecond DRF').toString('base64')}
 const second=await f.service.prepare(tenantA,f.user,secondInput)
 assert.equal(second.documentId,'doc2')
 assert.equal(second.status,'PREPARING')
 assert.equal(f.remote.roles.length,2)
 assert.deepEqual(f.remote.roles.map((r:any)=>[r.documentId,r.email]),[['doc1','signer@example.com'],['doc2','signer@example.com']])
 const drafts=f.calls.filter(c=>c.url.endsWith('/sign-requests')&&c.method==='POST')
 assert.equal(drafts.length,2)
 assert.equal(drafts[0].body.documentRoles[0].id,'role1')
 assert.equal(drafts[1].body.documentRoles[0].id,'role2')
})
test('refresh repairs a saved second DRF that inherited the first document role',async()=>{
 const f=fixture({rejectDraft:true})
 const first=await f.service.prepare(tenantA,f.user,f.input)
 f.remote.importComplete=true;await f.service.refresh(tenantA,first.id,true)
 const second=await f.service.prepare(tenantA,f.user,{...f.input,id:randomUUID(),fileData:Buffer.from('%PDF-1.7\nsecond DRF').toString('base64')})
 const row=f.db.tables.get('tenant_dochub_documents')!.find((r:any)=>r.id===second.id)
 row.data.signers[0].roleId='role1';row.data.rolesPrepared=true;row.data.draftAttempted=true
 const repaired=await f.service.refresh(tenantA,second.id,true)
 assert.equal(repaired.signers[0].roleId,'role2')
 assert(repaired.events.some((e:any)=>e.key==='recipients-repaired'))
 assert.equal(f.remote.roles.length,2,'the repair reuses the second document role')
 const drafts=f.calls.filter(c=>c.url.endsWith('/sign-requests')&&c.method==='POST')
 assert.equal(drafts.at(-1).body.documentRoles[0].id,'role2')
})
test('draft validation failure preserves unsent recipient roles without granting free editing',async()=>{const f=fixture({rejectDraft:true});f.remote.importComplete=true;const doc=await f.service.prepare(tenantA,f.user,f.input);assert.equal(doc.status,'SETUP_REQUIRED');assert(doc.setupNote);await f.service.refresh(tenantA,doc.id,true);assert.equal(f.calls.filter(c=>c.url.endsWith('/sign-requests')&&c.method==='POST').length,1);assert(!f.calls.some(c=>c.url.endsWith('/send')))})
test('a request created in DocHub clears obsolete setup guidance when signing starts',async()=>{
 const f=fixture({rejectDraft:true});f.remote.importComplete=true
 let doc=await f.service.prepare(tenantA,f.user,f.input)
 assert.equal(doc.status,'SETUP_REQUIRED');assert(doc.setupNote)
 f.remote.signRequestId='sr1';f.remote.status='IN_PROGRESS';f.remote.signed=true
 doc=await f.service.refresh(tenantA,doc.id,true)
 assert.equal(doc.status,'PARTIALLY_SIGNED');assert.equal(doc.setupNote,undefined)
 assert.equal((await f.service.load(tenantA,doc.id)).setupNote,undefined)
 f.remote.status='FINALIZED';doc=await f.service.refresh(tenantA,doc.id,true)
 assert.equal(doc.status,'COMPLETED');assert.equal(doc.setupNote,undefined)
 assert.equal(f.states.get(tenantA).items[0].status,'In Progress')
 assert(!f.calls.some(c=>c.url.endsWith('/send')))
})
test('document cards use current signing guidance even for saved records with stale setup notes',()=>{
 const setupNote='Place fields before creating the signing draft.'
 assert.equal(docHubGuidance({status:'SETUP_REQUIRED',setupNote}),setupNote)
 assert.match(docHubGuidance({status:'READY_TO_REVIEW',setupNote}),/review and send/)
 assert.match(docHubGuidance({status:'PARTIALLY_SIGNED',setupNote}),/Remaining signatures are pending/)
 assert.match(docHubGuidance({status:'COMPLETED',setupNote}),/Signing is complete/)
 for(const status of ['SENT','VIEWED','PARTIALLY_SIGNED','COMPLETED','VOIDED','REJECTED','EXPIRED','UNKNOWN'])assert(!docHubGuidance({status,setupNote}).includes(setupNote))
})
test('lost import response does not automatically duplicate the import',async()=>{const f=fixture({lostImport:true});const doc=await f.service.prepare(tenantA,f.user,f.input);assert.equal(doc.status,'REVIEW_REQUIRED');await f.service.refresh(tenantA,doc.id,true);assert.equal(f.calls.filter(c=>c.url.endsWith('/documents/imports')&&c.method==='POST').length,1)})
test('completion projection preserves existing follow-up and can append to archived work',()=>{const f=fixture(),state=f.states.get(tenantA);state.items[0].followUpDate='2026-10-01';const doc={id:'d1',title:'DRF',taskId:'task',createdBy:'admin',clientId:'client',status:'COMPLETED',signers:[],events:[{id:'e1',key:'complete',message:'Signature complete',createdAt:new Date().toISOString(),complete:true}],followUpDate:'2026-09-30'};const r=applyDocumentToWorkspace(state,doc);assert.equal(r.next.items[0].followUpDate,'2026-10-01');state.clients[0].archived=true;state.clients[0].status='Closed';r.next.clients=state.clients;assert.doesNotThrow(()=>assertLifecycleMutation(state,r.next,null));assert.throws(()=>assertLifecycleMutation(state,r.next,{role:'Administrator',modules:['items']}))})
test('status mapping requires DocHub FINALIZED for overall completion',()=>{assert.equal(signingStatus({status:'IN_PROGRESS',signersData:[{status:'FINALIZED'}]}),'PARTIALLY_SIGNED');assert.equal(signingStatus({status:'FINALIZED'}),'COMPLETED');assert.equal(signingStatus({status:'PREPARING'}),'PREPARING')})
test('signed PDF filename keeps the tracker document name and changes only the extension',()=>{
 assert.equal(signedPdfFileName({fileName:'DRF-CARD-INDOGROSIR-INC.xlsx',title:'ignored'}),'DRF-CARD-INDOGROSIR-INC.pdf')
 assert.equal(signedPdfFileName({title:'SO Client Main Branch.docx'}),'SO Client Main Branch.pdf')
 assert.equal(signedPdfFileName({title:'../unsafe:name.xlsx'}),'unsafe-name.pdf')
 assert.equal(signedPdfFileName({}),'signed-document.pdf')
})
test('signed PDF endpoint proxies DocHub storage and returns the document filename',async()=>{
 const f=fixture(),id=randomUUID(),createdAt='2026-09-29T03:00:00Z'
 f.db.tables.set('tenant_dochub_documents',[{tenant_id:tenantA,id,document_id:'doc1',updated_at:createdAt,data:{id,kind:'DRF',title:'DRF-CARD-INDOGROSIR-INC.xlsx',fileName:'DRF-CARD-INDOGROSIR-INC.xlsx',status:'COMPLETED',documentId:'doc1',compiledPdfId:'pdf1',createdAt,signers:[],events:[]}}])
 const app=express();f.deps.requireAuth=(req:any,_res:any,next:any)=>{req.authUser={id:'admin',role:'Administrator',modules:['documents','items'],organizationId:tenantA,accountType:'tenant'};next()};registerDocHubRoutes(app,f.deps,f.service)
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`
 try{
  const response=await fetch(`${base}/api/dochub/documents/${id}/pdf`)
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf')
  assert.match(response.headers.get('content-disposition') || '',/filename\*=UTF-8''DRF-CARD-INDOGROSIR-INC\.pdf/)
  assert.match(Buffer.from(await response.arrayBuffer()).toString(),/^%PDF-/)
  const storageCall=f.calls.find(c=>c.url.startsWith('https://bucket.s3.amazonaws.com/'));assert(storageCall);assert(!storageCall.headers?.['X-API-Token'])
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})
test('HTTP tenant access, admin-only settings and exact webhook verification',async()=>{
 const f=fixture(),app=express();f.deps.requireAuth=(req:any,res:any,next:any)=>{const role=req.get('x-role');if(!role)return res.sendStatus(401);req.authUser={id:'admin',role,modules:req.get('x-no-modules')?[]:['documents','settings','items'],organizationId:req.get('x-tenant')||tenantA,accountType:'tenant'};next()}
 registerDocHubWebhook(app,f.deps,f.service);app.use(express.json());registerDocHubRoutes(app,f.deps,f.service)
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`
 const call=(path:string,role='Administrator',method='GET',body?:any,tenant=tenantA)=>fetch(base+path,{method,headers:{'Content-Type':'application/json','x-role':role,'x-tenant':tenant},body:body?JSON.stringify(body):undefined})
 try{
  assert.equal((await fetch(base+'/api/dochub/documents')).status,401)
  for(const role of ['Viewer','Contributor'])assert.equal((await call('/api/account/dochub',role)).status,403)
  assert.equal((await call('/api/dochub/prepare','Viewer','POST',f.input)).status,403)
  const settings=await(await call('/api/account/dochub')).text();assert(!settings.includes(keyA));assert(!settings.includes('encrypted_api_key'))
  assert.equal((await call('/api/dochub/prepare','Administrator','POST',{...f.input,tenant_id:tenantB})).status,200)
  assert.equal((await call(`/api/dochub/documents/${f.input.id}/refresh`,'Administrator','POST',{},tenantB)).status,404)
  const raw=JSON.stringify({type:'webhook.ping',id:'event-1'}),ts=String(Math.floor(Date.now()/1000)),sig='dochub_v1='+createHmac('sha256','webhook-test-secret-1234').update(ts+'.'+raw).digest('hex')
  const headers={'Content-Type':'application/json','X-DocHub-Timestamp':ts,'X-DocHub-Signature-256':sig,'X-DocHub-Event':'webhook.ping','X-DocHub-Event-Id':'event-1'}
  assert.equal((await fetch(base+`/api/webhooks/dochub/${tenantA}`,{method:'POST',headers,body:raw})).status,204)
  assert.equal((await fetch(base+`/api/webhooks/dochub/${tenantA}`,{method:'POST',headers,body:raw+' '})).status,401)
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
})


test('signer notification eligibility disables completed signers and unsent documents',()=>{
 const pending={id:'signer1',name:'Signer',email:'signer@example.com',status:'CREATED'}
 assert.equal(canNotifyDocHubSigner('SENT',pending),true)
 assert.equal(canNotifyDocHubSigner('VIEWED',{...pending,viewedAt:'2026-10-01T00:00:00Z'}),true)
 assert.equal(canNotifyDocHubSigner('PREPARING',pending),false)
 assert.equal(canNotifyDocHubSigner('COMPLETED',pending),false)
 assert.equal(canNotifyDocHubSigner('PARTIALLY_SIGNED',{...pending,status:'FINALIZED'}),false)
 assert.equal(isDocHubSignerSigned({...pending,status:'FINALIZED'}),true)
})

test('pending signer reminder uses the native DocHub resend-email endpoint and preserves activity across refresh',async()=>{
 const f=fixture(),id=randomUUID(),createdAt='2026-10-01T04:30:00Z'
 f.remote.status='IN_PROGRESS';f.remote.signRequestId='sr1';f.remote.signed=false
 f.db.tables.set('tenant_dochub_documents',[{tenant_id:tenantA,id,document_id:'doc1',updated_at:createdAt,data:{id,kind:'DRF',title:'DRF-Gingersnaps-Sm-Santa-Rosa.xlsx',fileName:'DRF-Gingersnaps-Sm-Santa-Rosa.xlsx',status:'SENT',documentId:'doc1',signRequestId:'sr1',createdAt,createdBy:'admin',createdByName:'Admin',taskId:'task',clientId:'client',signers:[{id:'signer1',name:'Signer',email:'signer@example.com',status:'CREATED'}],events:[]}}])
 const actor={id:'admin',name:'Phillip Val R. Cabalo',username:'admin',role:'Administrator',modules:['documents']}
 let doc=await f.service.notifySigner(tenantA,id,'signer1',actor)
 const resend=f.calls.find(c=>c.url.endsWith('/api/v2/sign-requests/sr1/resend-email')&&c.method==='POST')
 assert(resend);assert.deepEqual(resend.body,{signerId:'signer1'});assert.equal(resend.headers['X-API-Token'],keyA)
 assert(doc.signers[0].notificationSentAt);assert.equal(doc.signers[0].notificationSentByName,'Phillip Val R. Cabalo')
 assert(doc.events.some((e:any)=>/resent the DocHub signing invitation to Signer/.test(e.message)))
 assert(f.states.get(tenantA).items[0].comments.some((c:any)=>/resent the DocHub signing invitation to Signer/.test(c.text)))
 doc=await f.service.refresh(tenantA,id,true)
 assert(doc.signers[0].notificationSentAt,'refresh must retain DocHub reminder metadata')
 await assert.rejects(()=>f.service.notifySigner(tenantA,id,'signer1',actor),(e:any)=>e.status===429&&/3 minutes/.test(e.message))
 f.remote.signed=true
 await assert.rejects(()=>f.service.notifySigner(tenantA,id,'signer1',actor),(e:any)=>e.status===409&&/already signed/.test(e.message))
})


test('DocHub egress: history excludes file bytes and filters by tenant and linked task',async()=>{
 const f=fixture()
 for(const [tenant,id,taskId] of [[tenantA,'doc-a','task'],[tenantA,'doc-unrelated','other'],[tenantB,'doc-b','task']]){
  await f.service.save(tenant,{id,taskId,status:'IMPORTING',title:id,createdByName:'Admin',signers:[],events:[],fileData:'a'.repeat(100000),fingerprint:'private'})
 }
 f.db.queries.length=0
 const result=await f.service.list(tenantA,'task')
 assert.deepEqual(result.documents.map((d:any)=>d.id),['doc-a'])
 assert(!JSON.stringify(result).includes('aaaa'));assert(!('fileData' in result.documents[0]))
 assert.equal(f.db.queries[0].columns.includes('data->fileData'),false)
 assert(f.db.queries[0].filters.some(([key,value]:any[])=>key==='tenant_id'&&value===tenantA))
 assert(f.db.queries[0].filters.some(([key,value]:any[])=>key==='data->>taskId'&&value==='task'))
 const revision=await f.service.revision(tenantA,'task');assert.equal(revision,result.revision)
 assert.equal(f.db.queries.at(-1)?.columns,'id,updated_at')
})

test('DocHub egress: active-tab scans use small pending metadata and skip unchanged workspace mirrors',async()=>{
 const f=fixture()
 await f.service.prepare(tenantA,f.user,f.input)
 await f.service.prepare(tenantB,{...f.user,organizationId:tenantB},{...f.input,id:randomUUID()})
 f.db.tables.get('tenant_dochub_documents')!.find((row:any)=>row.tenant_id===tenantA).data.checkedAt='2026-01-01T00:00:00Z'
 let workspaceLoads=0;const original=f.deps.load;f.deps.load=async(id:string)=>{workspaceLoads++;return original(id)}
 f.db.queries.length=0;f.calls.length=0
 await f.service.scan(tenantA)
 assert.equal(workspaceLoads,0)
 assert(f.calls.length>0);assert(f.calls.every(call=>call.headers['X-API-Token']===keyA))
 const query=f.db.queries.find((q:any)=>q.columns==='id,status:data->status,error:data->error,checkedAt:data->checkedAt,driveAutoSave:data->driveAutoSave,driveFile:data->driveFile,driveError:data->driveError,driveSkipped:data->driveSkipped,driveAttempts:data->driveAttempts')
 assert(query);assert(query.filters.some(([key,value]:any[])=>key==='tenant_id'&&value===tenantA))
 const calls=f.calls.length;await f.service.scan(tenantA);assert.equal(f.calls.length,calls)
})

test('DocHub egress: completed documents do not cause repeated full reads during active-tab scans',async()=>{
 const f=fixture()
 await f.service.save(tenantA,{id:'completed',status:'COMPLETED',signers:[],events:[]})
 let workspaceLoads=0;f.deps.load=async()=>{workspaceLoads++;throw new Error('unexpected workspace read')}
 f.db.queries.length=0
 await f.service.scan(tenantA)
 assert.equal(workspaceLoads,0);assert.equal(f.calls.length,0)
 assert(!f.db.queries.some((query:any)=>query.table==='tenant_dochub_documents'&&query.columns==='data'))
})

// ---- Fully signed documents are filed into the shared Google Drive ----
function driveFake(options:{ready?:boolean;fail?:number}={}) {
 const jobs:any[]=[];let failures=options.fail||0
 const filer={
  ready:async()=>options.ready!==false,
  file:async(job:any)=>{jobs.push(job);if(failures>0){failures--;throw new IntegrationError('Google Drive is busy. Wait a minute, then try again.',429)}
   return {file:{id:`drive-${jobs.length}`,url:`https://drive.google.com/file/d/drive-${jobs.length}/view`,name:job.name,savedAt:'2026-10-23T05:00:00.000Z'},path:['BA','Acme','Create DRF'],duplicate:false}},
 }
 return {filer,jobs}
}
async function signedFixture(drive:ReturnType<typeof driveFake>,input:any={}) {
 const f=fixture();f.deps.driveFiler=drive.filer;f.remote.importComplete=true
 let doc=await f.service.prepare(tenantA,f.user,{...f.input,...input});doc=await f.service.refresh(tenantA,doc.id,true)
 f.remote.fields=true;doc=await f.service.refresh(tenantA,doc.id,true)
 f.remote.status='IN_PROGRESS';doc=await f.service.refresh(tenantA,doc.id,true)
 return {f,doc}
}
test('Drive: a document that becomes fully signed is filed once, under its task, as the signed PDF',async()=>{
 const drive=driveFake(),{f,doc:sent}=await signedFixture(drive)
 assert.equal(drive.jobs.length,0,'Nothing is filed before the last signature')
 f.remote.status='FINALIZED';f.remote.signed=true
 const doc=await f.service.refresh(tenantA,sent.id,true)
 assert.equal(doc.status,'COMPLETED');assert.equal(drive.jobs.length,1)
 const job=drive.jobs[0]
 assert.equal(job.tenantId,tenantA);assert.equal(job.taskId,'task');assert.equal(job.clientId,'client');assert.equal(job.name,'DRF.pdf');assert.equal(job.mimeType,'application/pdf')
 assert.equal(job.user,null,'DocHub files it as the system');assert.equal(job.source,'dochub');assert.equal(job.bytes.subarray(0,5).toString(),'%PDF-');assert.equal(typeof job.commit,'function')
 assert.deepEqual({id:doc.driveFile.id,path:doc.driveFile.path},{id:'drive-1',path:'BA / Acme / Create DRF'})
 assert(doc.events.some((e:any)=>e.key==='drive:saved'&&e.message==='Signed PDF saved to Google Drive: BA / Acme / Create DRF.'))
 assert(f.states.get(tenantA).items[0].comments.some((c:any)=>c.text.includes('Signed PDF saved to Google Drive')),'The task shows the filing as a system comment')
 await f.service.refresh(tenantA,sent.id,true);await f.service.scan(tenantA)
 assert.equal(drive.jobs.length,1,'Refreshing or scanning again never files it twice')
 assert(!('fileData' in publicDocument(doc)));assert.equal(publicDocument(doc).driveFile.url,'https://drive.google.com/file/d/drive-1/view')
})
test('Drive: a failed filing keeps the signed record, is retried by the scan a few times, then the button works',async()=>{
 const drive=driveFake({fail:2}),{f,doc:sent}=await signedFixture(drive)
 f.remote.status='FINALIZED';f.remote.signed=true
 let doc=await f.service.refresh(tenantA,sent.id,true)
 assert.equal(doc.status,'COMPLETED','The signature itself is unaffected');assert.equal(doc.driveFile,undefined);assert.equal(doc.driveAttempts,1);assert.match(doc.driveError,/busy/)
 const saved=await f.service.load(tenantA,sent.id);saved.checkedAt='2020-01-01T00:00:00.000Z';await f.service.save(tenantA,saved)
 await f.service.scan(tenantA)
 assert.equal(drive.jobs.length,2,'The scan retried the filing');doc=await f.service.load(tenantA,sent.id);assert.equal(doc.driveAttempts,2);assert.match(doc.driveError,/busy/)
 doc=await f.service.saveToDrive(tenantA,sent.id)
 assert.equal(drive.jobs.length,3);assert.equal(doc.driveFile.id,'drive-3');assert.equal(doc.driveError,'')
 assert.equal((await f.service.saveToDrive(tenantA,sent.id)).driveFile.id,'drive-3');assert.equal(drive.jobs.length,3,'A document already filed is not filed again')
})
test('Drive: no connection or no task and client leaves a clear note, and the button files older signed documents',async()=>{
 const off=driveFake({ready:false}),a=await signedFixture(off)
 a.f.remote.status='FINALIZED';a.f.remote.signed=true
 let doc=await a.f.service.refresh(tenantA,a.doc.id,true)
 assert.equal(off.jobs.length,0);assert.match(doc.driveNote,/not connected/);assert.equal(doc.driveError,'')
 const on=driveFake();a.f.deps.driveFiler=on.filer
 doc=await a.f.service.saveToDrive(tenantA,a.doc.id);assert.equal(on.jobs.length,1);assert.equal(doc.driveFile.id,'drive-1')

 // No task or client: nothing to file under.
 const loose=driveFake(),b=await signedFixture(loose,{id:randomUUID(),taskId:'',clientId:''})
 b.f.remote.status='FINALIZED';b.f.remote.signed=true
 doc=await b.f.service.refresh(tenantA,b.doc.id,true)
 assert.equal(loose.jobs.length,0);assert.match(doc.driveNote,/no linked task or client/);assert.equal(doc.driveSkipped,true)
 await assert.rejects(()=>b.f.service.saveToDrive(tenantA,'missing'),(e:any)=>e.status===404)
 // Only a fully signed document can be filed.
 const c=await signedFixture(driveFake());await assert.rejects(()=>c.f.service.saveToDrive(tenantA,c.doc.id),(e:any)=>e.status===409)
})
test('Drive: with no filer the signing flow is unchanged, and a task removed before listing still counts as filed',async()=>{
 const none=await signedFixture(driveFake());none.f.deps.driveFiler=undefined
 none.f.remote.status='FINALIZED';none.f.remote.signed=true
 const doc=await none.f.service.refresh(tenantA,none.doc.id,true);assert.equal(doc.status,'COMPLETED');assert.equal(doc.driveFile,undefined);assert.equal(doc.driveError || '','')
 const gone={ready:async()=>true,file:async()=>{throw Object.assign(new IntegrationError('task removed',409),{code:'TASK_REMOVED',file:{id:'orphan',url:'https://drive.google.com/file/d/orphan/view',name:'DRF.pdf',savedAt:'2026-10-23T05:00:00.000Z'}})}}
 const orphan=await signedFixture(driveFake());orphan.f.deps.driveFiler=gone as any
 orphan.f.remote.status='FINALIZED';orphan.f.remote.signed=true
 const filed=await orphan.f.service.refresh(tenantA,orphan.doc.id,true);assert.equal(filed.driveFile.id,'orphan');assert.equal(filed.driveError,'')
})
