import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import express from 'express'
import { encryptSecret, decryptSecret } from '../server/integrations/tenant-integrations'
import { apiClient, DocHubError, docHubUrl, storageUrl, verifyDocHubWebhook, draftPacket, signingStatus } from '../server/integrations/dochub-api'
import { applyDocumentToWorkspace, createDocHubService, publicDocument, registerDocHubRoutes, registerDocHubWebhook, validatePreparation } from '../server/integrations/dochub'
import { assertLifecycleMutation } from '../src/lifecycle'
import { docHubGuidance } from '../src/dochub'
process.env.TENANT_INTEGRATION_MASTER_KEY='ab'.repeat(32)
const tenantA='11111111-1111-4111-8111-111111111111',tenantB='22222222-2222-4222-8222-222222222222'
const keyA='account-a-api-key-1234567890',keyB='account-b-api-key-1234567890'
const copy=(v:any)=>JSON.parse(JSON.stringify(v))
function database(){
 const tables=new Map<string,any[]>()
 return {tables,from(table:string){if(!tables.has(table))tables.set(table,[]);let filters:any[]=[],op='select',payload:any,single=false,limit=Infinity
  const q:any={select(){return q},eq(k:string,v:any){filters.push([k,v]);return q},maybeSingle(){single=true;return q},limit(v:number){limit=v;return q},order(){return q},upsert(v:any){op='upsert';payload=v;return q},update(v:any){op='update';payload=v;return q},then(resolve:any,reject:any){try{const rows=tables.get(table)!,match=(r:any)=>filters.every(([k,v])=>r[k]===v);if(op==='upsert'){const old=rows.findIndex(r=>r.tenant_id===payload.tenant_id&&r.id===payload.id);if(old<0)rows.push(copy(payload));else rows[old]=copy(payload)}if(op==='update')rows.filter(match).forEach(r=>Object.assign(r,copy(payload)));const found=rows.filter(match).slice(0,limit);resolve({data:copy(single?found[0]||null:found),error:null})}catch(e){reject(e)}}};return q
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
