import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { encryptSecret } from '../server/integrations/tenant-integrations'
import { registerCommunications } from '../server/integrations/communications'

function fixture() {
  const records:any[]=[{id:'11111111-1111-4111-8111-111111111111',tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'secret-mail',thread_id:'thread-a',subject:'Private subject',body:'Private full email thread',sender:'private@example.com',status:'New',received_at:new Date().toISOString()}]
  const gmailAccounts:any[]=[]
  const users:any[]=[{id:'user-a',role:'Contributor',status:'Active',modules:['inbox','items'],organization_id:'tenant'},{id:'user-b',role:'Contributor',status:'Active',modules:['inbox','items'],organization_id:'tenant'}]
  const prefs:any[]=[{tenant_id:'tenant',user_id:'user-a',discord_user_id:'123456789012345678',discord_capture_mentions:true},{tenant_id:'tenant',user_id:'user-b',discord_user_id:'234567890123456789',discord_capture_mentions:true}]
  let saved:any
  const state={clients:[{id:'client',name:'Client'}],projects:[{id:'project',name:'Project'}],accounts:[{id:'user-a',name:'Alice',status:'Active',role:'Contributor'},{id:'user-b',name:'Bob',status:'Active',role:'Contributor'}],items:[]}
  class Query {
    conditions:((x:any)=>boolean)[]=[]; action='read'; value:any; many=true
    orders:{key:string;ascending:boolean}[]=[]; start=0; end=Infinity; head=false
    constructor(public table:string) {}
    select(_columns='*',options?:any) {this.head=Boolean(options?.head);return this}
    eq(key:string,value:any){this.conditions.push(x=>x[key]===value);return this}
    contains(key:string,values:any[]){this.conditions.push(x=>values.every(v=>(x[key] || []).includes(v)));return this}
    neq(key:string,value:any){this.conditions.push(x=>x[key]!==value);return this}
    is(key:string,value:any){this.conditions.push(x=>x[key]===value || (value===null && x[key]===undefined));return this}
    in(key:string,values:any[]){this.conditions.push(x=>values.includes(x[key]));return this}
    order(key:string,options:{ascending:boolean}){this.orders.push({key,ascending:options.ascending});return this}
    limit(count:number){this.end=count-1;return this}
    range(start:number,end:number){this.start=start;this.end=end;return this}
    insert(value:any){this.action='insert';this.value=value;return this}
    update(value:any){this.action='update';this.value=value;return this}
    upsert(value:any){this.action='upsert';this.value=value;return this}
    maybeSingle(){this.many=false;return this.run()}
    single(){this.many=false;return this.run()}
    then(resolve:any,reject:any){return this.run().then(resolve,reject)}
    async run(){const rows=this.table==='user_communications'?records:this.table==='user_communication_settings'?prefs:this.table==='gmail_accounts'?gmailAccounts:users
      if(this.action==='insert'){const record={id:crypto.randomUUID(),...this.value};rows.push(record);return {data:this.many?null:record,error:null}}
      if(this.action==='update'){const found=rows.filter(x=>this.conditions.every(c=>c(x)));for(const row of found)Object.assign(row,this.value);return {data:this.many?null:found[0]||null,error:null}}
      if(this.action==='upsert'){const found=rows.find(x=>x.tenant_id===this.value.tenant_id && x.user_id===this.value.user_id);if(found)Object.assign(found,this.value);else rows.push(this.value);return {data:null,error:null}}
      const matched=rows.filter(x=>this.conditions.every(c=>c(x))).sort((a,b)=>{for(const {key,ascending} of this.orders){const result=String(a[key]).localeCompare(String(b[key]));if(result)return ascending?result:-result}return 0})
      if(this.start>0 && this.start>=matched.length)return {data:null,count:null,error:{code:'PGRST103'}}
      return {data:this.head?null:this.many?matched.slice(this.start,this.end+1):matched[0]||null,count:matched.length,error:null}
    }
  }
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{const id=String(req.headers['x-test-user']||'user-a');req.authUser={id,organizationId:'tenant',name:id,role:String(req.headers['x-test-role']||'Contributor'),modules:['inbox','items'],status:'Active'};next()})
  const hub=registerCommunications(app,{db:{from:(table:string)=>new Query(table)},requireAuth:(_req,_res,next)=>next(),requireTenant:(_req,_res,next)=>next(),sessionFromRequest:()=>({token:'session-a',user:null}),sessionByToken:(token:string)=>token==='session-a'?{id:'user-a',organizationId:'tenant',status:'Active'}:null,requirePlatformAdmin:(_req,_res,next)=>next(),organizationById:async()=>({id:'tenant',status:'Active',enabledModules:['inbox','items','settings']}),load:async()=>({data:state}),commit:async(_tenant,next)=>{saved=next},openStatus:()=> 'Open'})
  return {app,records,users,gmailAccounts,prefs,hub,getSaved:()=>saved}
}

test('private communications reject cross-user reads and task conversion',async()=>{
  const {app,getSaved}=fixture();const server=app.listen(0);try{
    const address=server.address();if(!address || typeof address==='string')throw new Error('No test port')
    const base=`http://127.0.0.1:${address.port}`;const privateId='11111111-1111-4111-8111-111111111111'
    const ask=(user:string,path:string,method='GET',body?:any)=>fetch(base+path,{method,headers:{'x-test-user':user,'content-type':'application/json'},body:body?JSON.stringify(body):undefined})
    const bob=await ask('user-b','/api/communications');assert.deepEqual((await bob.json()).items,[])
    assert.equal((await ask('user-b',`/api/communications/${privateId}`,'PATCH',{status:'Archived'})).status,404)
    const admin=await fetch(base+'/api/communications',{headers:{'x-test-user':'user-b','x-test-role':'Administrator'}});assert.deepEqual((await admin.json()).items,[])
    assert.equal((await ask('user-b',`/api/communications/${privateId}/create-task`,'POST',{title:'Steal',clientId:'client',projectId:'project',assignedToUserId:'user-b'})).status,404)
    const created=await ask('user-a',`/api/communications/${privateId}/create-task`,'POST',{title:'Check terminal 05',description:'Terminal 05 pending',clientId:'client',projectId:'project',assignedToUserId:'user-b'})
    assert.equal(created.status,201)
    const task=getSaved().items[0];assert.equal(task.assignedToUserId,'user-b');assert.equal(task.description,'Terminal 05 pending')
    assert.ok(!JSON.stringify(task).includes('Private full email thread'));assert.ok(!JSON.stringify(task).includes('private@example.com'));assert.ok(!JSON.stringify(task).includes(privateId))
  }finally{server.close()}
})

test('one Discord mention of two linked users produces two private records',async()=>{
  const {hub,records}=fixture();const count=await hub.captureDiscord({id:'discord-message',guildId:'server',channelId:'channel',channel:{name:'project'},mentions:{users:new Map([['123456789012345678',{}],['234567890123456789',{}]])},author:{id:'sender',username:'Jaime'},content:'@Alice @Bob please check',createdTimestamp:Date.now()},'tenant')
  assert.equal(count,2);assert.deepEqual(records.filter(x=>x.source==='Discord').map(x=>x.owner_user_id).sort(),['user-a','user-b'])
})


test('account OAuth setup is gated; Gmail callback and persisted label names stay private',async()=>{
  const previousKey=process.env.TENANT_INTEGRATION_MASTER_KEY
  process.env.TENANT_INTEGRATION_MASTER_KEY='a'.repeat(64)
  const {app,users}=fixture();users[0].role='Administrator';users[0].modules.push('settings')
  const server=app.listen(0),originalFetch=globalThis.fetch
  try{
    const address=server.address();if(!address || typeof address==='string')throw new Error('No test port')
    const base=`http://127.0.0.1:${address.port}`
    const local=(path:string,method='GET',body?:any,user='user-a',cookie='')=>originalFetch(base+path,{method,headers:{'x-test-user':user,'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'})
    assert.equal((await local('/api/account/gmail','PUT',{enabled:true,clientId:'test.apps.googleusercontent.com',clientSecret:'a-long-client-secret'})).status,403)
    assert.equal((await local('/api/internal-admin/organizations/tenant/gmail','PUT',{enabled:true})).status,200)
    assert.equal((await local('/api/account/gmail','PUT',{enabled:true,clientId:'test.apps.googleusercontent.com',clientSecret:'a-long-client-secret'})).status,200)
    assert.equal((await local('/api/account/gmail','PUT',{enabled:false},'user-b')).status,403)
    const connect=await local('/api/communications/gmail/connect');assert.equal(connect.status,200)
    const cookie=connect.headers.get('set-cookie') || '';assert.match(cookie,/ba_gmail_oauth=.*SameSite=Lax/i)
    const url=new URL((await connect.json()).url),state=url.searchParams.get('state')
    assert.equal(url.searchParams.get('client_id'),'test.apps.googleusercontent.com')
    let labelName='POS Registration',labelsUnavailable=false,labelCalls=0
    globalThis.fetch=(async(input:any,init:any)=>{
      const address=String(input)
      if(address==='https://oauth2.googleapis.com/token')return new Response(JSON.stringify({access_token:'access',refresh_token:'refresh',scope:'https://www.googleapis.com/auth/gmail.readonly'}),{status:200,headers:{'Content-Type':'application/json'}})
      if(address==='https://www.googleapis.com/oauth2/v3/userinfo')return new Response(JSON.stringify({email:'alice@example.com',email_verified:true}),{status:200,headers:{'Content-Type':'application/json'}})
      if(address==='https://gmail.googleapis.com/gmail/v1/users/me/labels'){
        labelCalls++
        return new Response(JSON.stringify(labelsUnavailable?{error:{message:'Google temporarily unavailable'}}:{labels:[{id:'Label_123',name:labelName,type:'user'},{id:'INBOX',name:'INBOX',type:'system'}]}),{status:labelsUnavailable?503:200,headers:{'Content-Type':'application/json'}})
      }
      if(address==='https://oauth2.googleapis.com/revoke')return new Response('{}',{status:200})
      return originalFetch(input,init)
    }) as typeof fetch
    const callback=await local(`/api/communications/gmail/callback?state=${state}&code=authorization-code`,'GET',undefined,'user-a',cookie.split(';')[0])
    assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),' /#gmail=connected'.trim())
    const status=await local('/api/communications/settings');assert.equal((await status.json()).gmailConnected,true)
    assert.equal((await local('/api/communications/gmail/labels')).status,200)
    assert.deepEqual((await (await local('/api/communications/settings')).json()).gmailLabelCatalog,[{id:'Label_123',name:'POS Registration'}])
    assert.equal(labelCalls,1,'Reloading settings must use stored label names without calling Google')
    assert.deepEqual((await (await local('/api/communications/settings','GET',undefined,'user-b')).json()).gmailLabelCatalog,[])
    await local('/api/communications/settings','PUT',{discordUserId:'123456789012345678',captureMentions:true,gmailLabels:['Label_123'],gmailLabelCatalog:[{id:'Label_123',name:'Client supplied name'}]})
    assert.equal((await (await local('/api/communications/settings')).json()).gmailLabelCatalog[0].name,'POS Registration')
    labelName='POS Registration — updated'
    await local('/api/communications/gmail/labels')
    labelsUnavailable=true
    assert.equal((await local('/api/communications/gmail/labels')).status,502)
    assert.equal((await (await local('/api/communications/settings')).json()).gmailLabelCatalog[0].name,labelName)
    assert.equal((await local('/api/communications/gmail','DELETE')).status,200)
    assert.deepEqual((await (await local('/api/communications/settings')).json()).gmailLabelCatalog,[])
  }finally{globalThis.fetch=originalFetch;server.close();if(previousKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=previousKey}
})

test('pagination filters before counting, reaches older records and isolates threads by owner and tenant',async()=>{
  const {app,records}=fixture(),sample=records[0]
  records.splice(0,records.length,...Array.from({length:217},(_,i)=>({...sample,id:`message-${String(i).padStart(4,'0')}`,source:i<210?'Gmail':'Discord',source_label:i<210?'pos':'',source_labels:i<210?['pos']:[],received_at:new Date(2026,0,1,0,i).toISOString()})))
  records.push({...sample,id:'archived',status:'Archived'}, {...sample,id:'other-user',owner_user_id:'user-b'}, {...sample,id:'other-tenant',tenant_id:'other-tenant'})
  const server=app.listen(0)
  try {
    const address=server.address();if(!address || typeof address==='string')throw new Error('No test port')
    const base=`http://127.0.0.1:${address.port}`
    const get=async(path:string,user='user-a')=>{const result=await fetch(base+path,{headers:{'x-test-user':user}});return {status:result.status,body:await result.json()}}
    for(const size of [5,10,15]){
      const first=await get(`/api/communications?page=1&pageSize=${size}&tab=Gmail&label=pos`)
      const second=await get(`/api/communications?page=2&pageSize=${size}&tab=Gmail&label=pos`)
      assert.equal(first.body.total,210);assert.equal(first.body.items.length,size)
      assert.ok(second.body.items.every((x:any)=>!first.body.items.some((y:any)=>x.id===y.id)))
    }
    const older=await get('/api/communications?page=42&pageSize=5&tab=Gmail&label=pos')
    assert.equal(older.body.items.length,5);assert.equal(older.body.items.at(-1).id,'message-0000')
    const beyond=await get('/api/communications?page=43&pageSize=5&tab=Gmail&label=pos')
    assert.equal(beyond.status,200);assert.equal(beyond.body.total,210);assert.deepEqual(beyond.body.items,[])
    const discord=await get('/api/communications?page=1&pageSize=10&tab=Discord&label=pos')
    assert.equal(discord.body.total,7);assert.ok(discord.body.items.every((x:any)=>x.source==='Discord'))
    assert.equal((await get('/api/communications?page=1&pageSize=5&tab=Archived')).body.total,1)
    assert.equal((await get('/api/communications?page=1&pageSize=5&tab=Gmail&archived=true')).body.total,1)
    assert.equal((await get('/api/communications?page=1&pageSize=5&tab=Discord&archived=true')).body.total,0)
    assert.equal((await get('/api/communications?page=1&pageSize=5&tab=Gmail&label=missing')).body.total,0)
    assert.equal((await get('/api/communications?page=1&pageSize=5&tab=All','user-b')).body.total,1)
    for(const query of ['page=0','page=1.5','page=bad','pageSize=200','tab=Unknown'])assert.equal((await get(`/api/communications?${query}`)).status,400)
    const thread=await get('/api/communications/message-0000/thread')
    assert.equal(thread.body.total,211);assert.equal(thread.body.items.length,50)
    assert.ok(thread.body.items.every((x:any)=>x.owner_user_id==='user-a' && x.tenant_id==='tenant' && x.source==='Gmail'))
    const next=await get('/api/communications/message-0000/thread?page=2')
    assert.ok(next.body.items.every((x:any)=>!thread.body.items.some((y:any)=>x.id===y.id)))
    assert.equal((await get('/api/communications/message-0000/thread','user-b')).status,404)
    assert.equal((await get('/api/communications/other-tenant/thread')).status,404)
  } finally {server.close()}
})


test('Gmail functional sync imports beyond page one, updates existing messages, and preserves all labels and HTML body',async()=>{
 const oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY
 process.env.TENANT_INTEGRATION_MASTER_KEY='b'.repeat(64)
 const {app,records,gmailAccounts,prefs}=fixture()
 gmailAccounts.push({tenant_id:'tenant',platform_enabled:true,account_enabled:true,revision:'v1',encrypted_config:encryptSecret(JSON.stringify({clientId:'test',clientSecret:'fixture',redirectUri:'http://localhost'}),'tenant','gmail-oauth')})
 Object.assign(prefs[0],{gmail_labels:['L1','L2'],gmail_config_revision:'v1',gmail_refresh_token:encryptSecret('fixture-refresh','tenant:user-a','gmail-refresh')})
 const server=app.listen(0),original=globalThis.fetch
 const seenPages:string[]=[]
 const seenQueries:string[]=[]
 const realNow=Date.now;let clock=realNow()
 Date.now=()=>clock
 let detailCalls=0, newMessage=false
 try {
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
  const base=`http://127.0.0.1:${address.port}`
  globalThis.fetch=(async(input:any)=>{
    const url=new URL(String(input));let body:any
    if(url.hostname==='oauth2.googleapis.com') body={access_token:'fixture-access'}
    else if(url.pathname.endsWith('/messages')) {
      const label=url.searchParams.get('labelIds'),token=url.searchParams.get('pageToken')||'';seenPages.push(`${label}:${token}`);seenQueries.push(url.searchParams.get('q')||'')
      const page=Number(token||0),size=Number(url.searchParams.get('maxResults')),start=page*size,count=Math.min(size,Math.max(0,65-start))
      assert.equal(size,20)
      body=label==='L2'?{messages:[{id:'m0'}]}:{messages:Array.from({length:count},(_,i)=>({id:newMessage && page===0 && i===0?'m65':`m${start+i}`})),...(start+count<65?{nextPageToken:String(page+1)}:{})}
    } else { detailCalls++;const id=url.pathname.split('/').pop();body={id,threadId:'thread',labelIds:['L1','L2'],internalDate:'1790553600000',snippet:'Too short',payload:{mimeType:'text/html',headers:[{name:'Subject',value:'Fixture email'}],body:{data:Buffer.from('<p>Supervisor approval required.</p><p>Refund limit: 500.</p>').toString('base64url')}}} }
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})
  }) as typeof fetch
  const sync=await original(base+'/api/communications/gmail/sync',{method:'POST'});assert.equal(sync.status,200)
  const result=await sync.json();assert.equal(result.imported,40);assert.equal(result.hasMore,true)
  assert.deepEqual(seenPages,['L1:','L2:','L1:1'])
  assert.ok(seenQueries.every(q=>q===`after:${Math.floor(clock/1000)-10*86400}`))
  const paused=await original(base+'/api/communications/gmail/sync',{method:'POST'});assert.equal(paused.status,200)
  assert.ok((await paused.json()).retryAfterSeconds>0)
  clock+=61_000;newMessage=true
  const next=await original(base+'/api/communications/gmail/sync',{method:'POST'});assert.equal(next.status,200)
  assert.equal((await next.json()).imported,21,'New mail should arrive even while older pages are still being scanned')
  clock+=61_000
  const automatic=await original(base+'/api/communications/gmail/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({auto:true})})
  assert.equal(automatic.status,200);assert.equal((await automatic.json()).imported,5)
  const imported=records.filter(r=>r.external_id?.startsWith('m'))
  assert.equal(imported.length,66);assert.deepEqual(imported[0].source_labels,['L1','L2']);assert.match(imported[0].body,/Refund limit: 500/)
  assert.deepEqual(seenPages.slice(0,9),['L1:','L2:','L1:1','L1:','L2:','L1:2','L1:','L2:','L1:3'])
  const filtered=await original(base+'/api/communications?tab=Gmail&label=L2&page=1');assert.equal(filtered.status,200);assert.equal((await filtered.json()).total,66)
  imported[0].status='Archived';imported[0].linked_task_id='task'
  detailCalls=0
  const second=await original(base+'/api/communications/gmail/sync',{method:'POST'});assert.equal(second.status,200);assert.equal((await second.json()).imported,0)
  assert.equal(detailCalls,0,'Manual checks must not re-download existing message bodies')
  assert.equal(imported[0].status,'Archived');assert.equal(imported[0].linked_task_id,'task')
 } finally {Date.now=realNow;globalThis.fetch=original;server.close();if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
})

test('Gmail quota errors pause new checks and resume without losing the scan state',async()=>{
 const oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY,original=globalThis.fetch,realNow=Date.now
 process.env.TENANT_INTEGRATION_MASTER_KEY='c'.repeat(64)
 const {app,gmailAccounts,prefs}=fixture()
 gmailAccounts.push({tenant_id:'tenant',platform_enabled:true,account_enabled:true,revision:'v1',encrypted_config:encryptSecret(JSON.stringify({clientId:'test',clientSecret:'fixture',redirectUri:'http://localhost'}),'tenant','gmail-oauth')})
 Object.assign(prefs[0],{gmail_labels:['L1'],gmail_config_revision:'v1',gmail_refresh_token:encryptSecret('fixture-refresh','tenant:user-a','gmail-refresh')})
 const server=app.listen(0);let clock=realNow(),listCalls=0,quota=true
 Date.now=()=>clock
 try {
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
  const base=`http://127.0.0.1:${address.port}`
  globalThis.fetch=(async(input:any)=>{
   const url=new URL(String(input))
   if(url.hostname==='oauth2.googleapis.com')return new Response(JSON.stringify({access_token:'fixture-access'}),{status:200,headers:{'content-type':'application/json'}})
   listCalls++
   return new Response(JSON.stringify(quota?{error:{message:"Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"}}:{messages:[]}),{status:quota?403:200,headers:{'content-type':'application/json'}})
  }) as typeof fetch
  const failed=await original(base+'/api/communications/gmail/sync',{method:'POST'})
  assert.equal(failed.status,429);assert.match((await failed.json()).error,/Gmail quota is temporarily exceeded/)
  assert.equal((await original(base+'/api/communications/gmail/sync',{method:'POST'})).status,429)
  assert.equal(listCalls,1,'The cooldown must prevent another Gmail request')
  assert.deepEqual(prefs[0].gmail_sync_state || {},{})
  clock+=61_000;quota=false
  const resumed=await original(base+'/api/communications/gmail/sync',{method:'POST'})
  assert.equal(resumed.status,200);assert.equal((await resumed.json()).hasMore,false);assert.equal(listCalls,2)
 } finally {globalThis.fetch=original;Date.now=realNow;server.close();if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
})
