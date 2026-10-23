import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { encryptSecret } from '../server/integrations/tenant-integrations'
import { registerCommunications } from '../server/integrations/communications'

function fixture(options: { failLink?: boolean } = {}) {
  const records:any[]=[{id:'11111111-1111-4111-8111-111111111111',tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'secret-mail',thread_id:'thread-a',subject:'Private subject',body:'Private full email thread',sender:'private@example.com',status:'New',received_at:new Date().toISOString()}]
  const gmailAccounts:any[]=[]
  const driveRows:any[]=[]
  const users:any[]=[{id:'user-a',role:'Contributor',status:'Active',modules:['inbox','items'],organization_id:'tenant'},{id:'user-b',role:'Contributor',status:'Active',modules:['inbox','items'],organization_id:'tenant'}]
  const prefs:any[]=[{tenant_id:'tenant',user_id:'user-a',discord_user_id:'123456789012345678',discord_capture_mentions:true},{tenant_id:'tenant',user_id:'user-b',discord_user_id:'234567890123456789',discord_capture_mentions:true}]
  let saved:any
  const state:any={clients:[{id:'client',name:'Client'}],projects:[{id:'project',name:'Project'}],accounts:[{id:'user-a',name:'Alice',status:'Active',role:'Contributor'},{id:'user-b',name:'Bob',status:'Active',role:'Contributor'}],items:[]}
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
    upsert(value:any,options?:any){this.action='upsert';this.value=value;this.conflict=String(options?.onConflict||'tenant_id,user_id').split(',');return this}
    delete(){this.action='delete';return this}
    conflict:string[]=[]
    maybeSingle(){this.many=false;return this.run()}
    single(){this.many=false;return this.run()}
    then(resolve:any,reject:any){return this.run().then(resolve,reject)}
    async run(){const rows=this.table==='user_communications'?records:this.table==='user_communication_settings'?prefs:this.table==='gmail_accounts'?gmailAccounts:this.table==='tenant_drive_accounts'?driveRows:users
      if(this.action==='insert'){const record={id:crypto.randomUUID(),...this.value};rows.push(record);return {data:this.many?null:record,error:null}}
      if(this.action==='update'){if(options.failLink && this.table==='user_communications' && this.value.linked_task_id)return {data:null,error:{message:'Badge write failed'}};const found=rows.filter(x=>this.conditions.every(c=>c(x)));for(const row of found)Object.assign(row,this.value);return {data:this.many?null:found[0]||null,error:null}}
      if(this.action==='delete'){for(let i=rows.length-1;i>=0;i--)if(this.conditions.every(c=>c(rows[i])))rows.splice(i,1);return {data:null,error:null}}
      if(this.action==='upsert'){const found=rows.find(x=>this.conflict.every(key=>x[key]===this.value[key]));if(found)Object.assign(found,this.value);else rows.push(this.value);return {data:null,error:null}}
      const matched=rows.filter(x=>this.conditions.every(c=>c(x))).sort((a,b)=>{for(const {key,ascending} of this.orders){const result=String(a[key]).localeCompare(String(b[key]));if(result)return ascending?result:-result}return 0})
      if(this.start>0 && this.start>=matched.length)return {data:null,count:null,error:{code:'PGRST103'}}
      return {data:this.head?null:this.many?matched.slice(this.start,this.end+1):matched[0]||null,count:matched.length,error:null}
    }
  }
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{const id=String(req.headers['x-test-user']||'user-a');req.authUser={id,organizationId:'tenant',name:id,role:String(req.headers['x-test-role']||'Contributor'),modules:String(req.headers['x-test-modules']||'inbox,items').split(','),status:'Active'};next()})
  const hub=registerCommunications(app,{db:{from:(table:string)=>new Query(table)},requireAuth:(_req,_res,next)=>next(),requireTenant:(_req,_res,next)=>next(),sessionFromRequest:()=>({token:'session-a',user:null}),sessionByToken:(token:string)=>token==='session-a'?{id:'user-a',organizationId:'tenant',status:'Active'}:null,requirePlatformAdmin:(_req,_res,next)=>next(),organizationById:async()=>({id:'tenant',status:'Active',enabledModules:['inbox','items','settings']}),load:async()=>({data:saved || state}),commit:async(_tenant,next)=>{saved=next},openStatus:()=> 'Open'})
  return {app,records,users,gmailAccounts,driveRows,prefs,hub,state,getSaved:()=>saved}
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

async function taskFixture(options: { failLink?: boolean } = {}) {
  const data=fixture(options),server=data.app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address();if(!address || typeof address==='string')throw new Error('No test port')
  const base=`http://127.0.0.1:${address.port}`
  const create=async(title:string,patch:any={},messageId=data.records[0].id)=>{
    const response=await fetch(`${base}/api/communications/${messageId}/create-task`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,description:'Shared summary',clientId:'client',projectId:'project',assignedToUserId:'user-b',...patch})})
    return {status:response.status,body:await response.json()}
  }
  return {...data,create,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

test('one Gmail message creates multiple distinct tasks without a new session',async()=>{
  const f=await taskFixture()
  try {
    const first=await f.create('Check terminal 05'),second=await f.create('Check terminal 06')
    assert.equal(first.status,201);assert.equal(second.status,201)
    assert.notEqual(first.body.task.id,second.body.task.id)
    assert.deepEqual(f.getSaved().items.map((item:any)=>item.title),['Check terminal 06','Check terminal 05'])
    assert.equal(f.records[0].linked_task_id,second.body.task.id)
    for(const task of f.getSaved().items){assert.equal(task.assignedToUserId,'user-b');assert(!JSON.stringify(task).includes('private@example.com'));assert(!JSON.stringify(task).includes('secret-mail'));assert(!JSON.stringify(task).includes(f.records[0].id))}
  } finally {await f.close()}
})

test('task duplicates ignore case and whitespace and are blocked across emails and assignees',async()=>{
  const f=await taskFixture()
  try {
    const first=await f.create('Check terminal 05')
    f.records.push({...f.records[0],id:'second-email',linked_task_id:null})
    for(const messageId of [f.records[0].id,'second-email']){
      const duplicate=await f.create('  CHECK   terminal 05  ',{description:'Different description',assignedToUserId:'user-a'},messageId)
      assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'DUPLICATE_TASK');assert.equal(duplicate.body.taskId,first.body.task.id)
    }
    assert.equal(f.getSaved().items.length,1);assert.equal(f.records[0].linked_task_id,first.body.task.id)
    assert.equal((await f.create('Check terminal 06')).status,201)
  } finally {await f.close()}
})

test('task duplicate validation uses client/project and excludes subtasks and other item types',async()=>{
  const f=await taskFixture()
  try {
    f.state.clients.push({id:'other-client',name:'Other client'});f.state.projects.push({id:'other-project',name:'Other project'})
    f.state.items.push({id:'subtask',type:'Task',parentTaskId:'parent',clientId:'client',projectId:'project',title:'Verify rollout'},{id:'issue',type:'Issue',clientId:'client',projectId:'project',title:'Verify rollout'})
    assert.equal((await f.create('Verify rollout')).status,201)
    assert.equal((await f.create('Verify rollout',{projectId:'other-project'})).status,201)
    assert.equal((await f.create('Verify rollout',{clientId:'other-client'})).status,201)
    assert.equal((await f.create('Verify rollout')).status,409)
    assert.equal(f.getSaved().items.filter((item:any)=>!item.parentTaskId && item.type==='Task').length,3)
  } finally {await f.close()}
})

test('concurrent task submissions preserve distinct tasks and reject repeated titles',async()=>{
  const f=await taskFixture()
  try {
    const duplicates=await Promise.all([f.create('Concurrent check'),f.create(' concurrent   CHECK ')])
    assert.deepEqual(duplicates.map(result=>result.status).sort(),[201,409]);assert.equal(f.getSaved().items.length,1)
    const distinct=await Promise.all([f.create('Second check'),f.create('Third check')])
    assert.deepEqual(distinct.map(result=>result.status),[201,201]);assert.equal(f.getSaved().items.length,3)
  } finally {await f.close()}
})

test('invalid task fields do not save and failed message badges do not hide a saved task',async()=>{
  const f=await taskFixture({failLink:true})
  try {
    for(const patch of [{title:' '},{clientId:''},{projectId:'missing'},{assignedToUserId:'missing'}])assert.equal((await f.create('Valid task',patch)).status,400)
    assert.equal(f.getSaved(),undefined)
    const result=await f.create('Valid task');assert.equal(result.status,201);assert.match(result.body.warning,/badge/);assert.equal(f.getSaved().items.length,1)
    assert.equal((await f.create('Valid task')).status,409)
    assert.equal((await f.create('Another task')).status,201);assert.equal(f.getSaved().items.length,2)
  } finally {await f.close()}
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
    // Reading mail never asks for permission to send. Sending is a separate, opt-in step.
    assert.doesNotMatch(url.searchParams.get('scope') || '',/gmail\.send/)
    assert.deepEqual((await (await local('/api/communications/send/status')).json()).canSend,false)
    {
      const readFetch=globalThis.fetch
      const withScope=(scope:string)=>{globalThis.fetch=(async(input:any,init:any)=>{
        if(String(input)==='https://oauth2.googleapis.com/token'){return new Response(JSON.stringify({access_token:'access',refresh_token:'refresh-send',scope,expires_in:3600}),{status:200,headers:{'Content-Type':'application/json'}})}
        return readFetch(input,init)}) as typeof fetch}
      const allow=async(scope:string)=>{
        const start=await local('/api/communications/gmail/connect?send=1');const link=new URL((await start.json()).url)
        assert.match(link.searchParams.get('scope') || '',/gmail\.readonly/);assert.match(link.searchParams.get('scope') || '',/gmail\.send/)
        withScope(scope)
        return local(`/api/communications/gmail/callback?state=${link.searchParams.get('state')}&code=send-code`,'GET',undefined,'user-a',(start.headers.get('set-cookie') || '').split(';')[0])
      }
      // Google lets people untick one permission: the connection still works, and the tracker says sending was not allowed.
      const denied=await allow('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email');assert.equal(denied.headers.get('location'),'/#gmail=send-denied')
      assert.equal((await (await local('/api/communications/settings')).json()).gmailConnected,true)
      assert.equal((await (await local('/api/communications/send/status')).json()).canSend,false)
      const allowed=await allow('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email');assert.equal(allowed.headers.get('location'),'/#gmail=send-enabled')
      const ready=await (await local('/api/communications/send/status')).json();assert.deepEqual([ready.connected,ready.canSend,ready.email],[true,true,'alice@example.com'])
      // Reconnecting later keeps the permission instead of silently dropping it.
      const again=new URL((await (await local('/api/communications/gmail/connect')).json()).url);assert.match(again.searchParams.get('scope') || '',/gmail\.send/)
      globalThis.fetch=readFetch
    }
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

test('Gmail attachment helpers keep stored order, match safely and build safe download headers',async()=>{
 const {gmailAttachmentParts,gmailAttachmentSummaries,storedAttachment,matchAttachmentPart,attachmentDisposition,attachmentContentType}=await import('../server/integrations/gmail-content')
 const payload={mimeType:'multipart/mixed',parts:[
  {partId:'0',mimeType:'multipart/alternative',parts:[{partId:'0.0',mimeType:'text/plain',body:{data:'aGk'}}]},
  {partId:'1',mimeType:'application/pdf',filename:'report.pdf',body:{attachmentId:'att-1',size:2048}},
  {partId:'2',mimeType:'multipart/related',parts:[{partId:'2.1',mimeType:'image/png',filename:'logo.png',body:{data:'iVBO',size:4}}]},
 ]}
 const parts=gmailAttachmentParts(payload)
 assert.deepEqual(parts.map(p=>[p.name,p.partId]),[['report.pdf','1'],['logo.png','2.1']])
 assert.deepEqual(gmailAttachmentSummaries(payload),[{name:'report.pdf',partId:'1',mimeType:'application/pdf',size:2048},{name:'logo.png',partId:'2.1',mimeType:'image/png',size:4}])
 assert.ok(!JSON.stringify(gmailAttachmentSummaries(payload)).includes('att-1'),'Unstable attachment ids and file data must not be stored')
 assert.deepEqual(storedAttachment('legacy.txt'),{name:'legacy.txt'})
 assert.deepEqual(storedAttachment({name:'report.pdf',partId:'1',size:9}),{name:'report.pdf',partId:'1'})
 assert.equal(storedAttachment(''),null);assert.equal(storedAttachment({partId:'1'}),null);assert.equal(storedAttachment(null),null)
 assert.equal(matchAttachmentPart(parts,{name:'report.pdf',partId:'1'},5)?.partId,'1')
 assert.equal(matchAttachmentPart(parts,{name:'other.pdf',partId:'1'},0),null,'A part id must also match the stored name')
 assert.equal(matchAttachmentPart(parts,{name:'logo.png'},1)?.partId,'2.1')
 assert.equal(matchAttachmentPart(parts,{name:'logo.png'},0)?.partId,'2.1','Legacy rows fall back to a unique name')
 assert.equal(matchAttachmentPart([...parts,{...parts[1],partId:'3'}],{name:'logo.png'},0),null,'Ambiguous legacy names are not guessed')
 const header=attachmentDisposition('../evil"\r\nSet-Cookie: x=1.pdf')
 assert.match(header,/^attachment; /);assert.ok(!/[\r\n]/.test(header));assert.ok(!header.includes('../'));assert.ok(!/filename="[^"]*"[^;]*"/.test(header))
 assert.match(attachmentDisposition('Ü-Bericht.pdf'),/filename="_-Bericht\.pdf"; filename\*=UTF-8''%C3%9C-Bericht\.pdf$/)
 assert.equal(attachmentDisposition('...'),'attachment; filename="attachment"; filename*=UTF-8\'\'attachment')
 assert.equal(attachmentContentType('Application/PDF'),'application/pdf')
 assert.equal(attachmentContentType('text/html\r\nX-Bad: 1'),'application/octet-stream')
 assert.equal(attachmentContentType(''),'application/octet-stream')
})

test('Gmail sync stores attachment metadata only',async()=>{
 const oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY,original=globalThis.fetch
 process.env.TENANT_INTEGRATION_MASTER_KEY='d'.repeat(64)
 const {app,records,gmailAccounts,prefs}=fixture()
 gmailAccounts.push({tenant_id:'tenant',platform_enabled:true,account_enabled:true,revision:'v1',encrypted_config:encryptSecret(JSON.stringify({clientId:'test',clientSecret:'fixture',redirectUri:'http://localhost'}),'tenant','gmail-oauth')})
 Object.assign(prefs[0],{gmail_labels:['L1'],gmail_config_revision:'v1',gmail_refresh_token:encryptSecret('fixture-refresh','tenant:user-a','gmail-refresh')})
 const server=app.listen(0)
 try {
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
  globalThis.fetch=(async(input:any)=>{
   const url=new URL(String(input));let body:any
   if(url.hostname==='oauth2.googleapis.com') body={access_token:'fixture-access'}
   else if(url.pathname.endsWith('/messages')) body={messages:[{id:'with-files'}]}
   else body={id:'with-files',threadId:'t',labelIds:['L1'],internalDate:String(Date.now()),payload:{mimeType:'multipart/mixed',headers:[{name:'Subject',value:'Files'}],parts:[{partId:'0',mimeType:'text/plain',body:{data:Buffer.from('See attached').toString('base64url')}},{partId:'1',mimeType:'application/pdf',filename:'invoice.pdf',body:{attachmentId:'secret-attachment-id',size:1234}}]}}
   return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})
  }) as typeof fetch
  assert.equal((await original(`http://127.0.0.1:${address.port}/api/communications/gmail/sync`,{method:'POST'})).status,200)
  const saved=records.find(r=>r.external_id==='with-files')
  assert.deepEqual(saved.attachments,[{name:'invoice.pdf',partId:'1',mimeType:'application/pdf',size:1234}])
  assert.ok(!JSON.stringify(saved).includes('secret-attachment-id'))
 } finally {globalThis.fetch=original;server.close();if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
})

test('Gmail attachments download from Gmail on demand for the owner only and are never stored',async()=>{
 const oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY,original=globalThis.fetch
 process.env.TENANT_INTEGRATION_MASTER_KEY='e'.repeat(64)
 const {app,records,gmailAccounts,prefs}=fixture()
 gmailAccounts.push({tenant_id:'tenant',platform_enabled:true,account_enabled:true,revision:'v1',encrypted_config:encryptSecret(JSON.stringify({clientId:'test',clientSecret:'fixture',redirectUri:'http://localhost'}),'tenant','gmail-oauth')})
 Object.assign(prefs[0],{gmail_labels:['L1'],gmail_config_revision:'v1',gmail_refresh_token:encryptSecret('fixture-refresh','tenant:user-a','gmail-refresh')})
 const withFiles='22222222-2222-4222-8222-222222222222',legacy='33333333-3333-4333-8333-333333333333',removed='44444444-4444-4444-8444-444444444444'
 records.push(
  {id:withFiles,tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'msg-files',subject:'Files',body:'',sender:'a@example.com',status:'New',received_at:new Date().toISOString(),attachments:[{name:'report.pdf',partId:'1',mimeType:'application/pdf',size:11},{name:'page.html',partId:'2',mimeType:'text/html',size:28}]},
  {id:legacy,tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'msg-files',subject:'Legacy',body:'',sender:'a@example.com',status:'New',received_at:new Date().toISOString(),attachments:['report.pdf']},
  {id:removed,tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'msg-gone',subject:'Gone',body:'',sender:'a@example.com',status:'New',received_at:new Date().toISOString(),attachments:['old.pdf']})
 const pdf=Buffer.from('%PDF-1.4 ok'),html=Buffer.from('<script>alert(1)</script>ok')
 let gmailCalls=0,detailFetches=0
 const server=app.listen(0)
 try {
  const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
  const base=`http://127.0.0.1:${address.port}`
  globalThis.fetch=(async(input:any)=>{
   const url=new URL(String(input));gmailCalls++
   const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
   if(url.hostname==='oauth2.googleapis.com') return json({access_token:'fixture-access'})
   if(url.pathname.includes('/messages/msg-gone')) return json({error:{message:'Requested entity was not found.'}},404)
   const attachment=/\/attachments\/(.+)$/.exec(url.pathname)
   if(attachment) {
    // Gmail issues a different attachment id on every message fetch; only the latest must be used.
    assert.ok(attachment[1].endsWith(`-${detailFetches}`),'The download must use the attachment id from the fresh message fetch')
    return json({size:pdf.length,data:pdf.toString('base64url')})
   }
   detailFetches++
   return json({id:'msg-files',payload:{mimeType:'multipart/mixed',parts:[{partId:'0',mimeType:'text/plain',body:{data:'aGk'}},{partId:'1',mimeType:'application/pdf',filename:'report.pdf',body:{attachmentId:`pdf-${detailFetches}`,size:pdf.length}},{partId:'2',mimeType:'text/html',filename:'page.html',body:{data:html.toString('base64url'),size:html.length}}]}})
  }) as typeof fetch
  const before=JSON.stringify(records)
  const get=(id:string,index:string|number,user='user-a')=>original(`${base}/api/communications/${id}/attachments/${index}`,{headers:{'x-test-user':user}})

  const download=await get(withFiles,0)
  assert.equal(download.status,200)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf)
  assert.equal(download.headers.get('content-type'),'application/pdf')
  assert.equal(download.headers.get('content-disposition'),`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
  assert.equal(download.headers.get('x-content-type-options'),'nosniff')
  assert.match(download.headers.get('content-security-policy') || '',/sandbox/)
  assert.equal(download.headers.get('cache-control'),'no-store')

  const page=await get(withFiles,1)
  assert.equal(page.status,200);assert.deepEqual(Buffer.from(await page.arrayBuffer()),html)
  assert.match(page.headers.get('content-disposition') || '',/^attachment; filename="page\.html"/,'HTML must download, never render on the app origin')
  assert.match(page.headers.get('content-security-policy') || '',/sandbox/)

  const old=await get(legacy,0);assert.equal(old.status,200,'Rows synced before metadata existed still download by name')
  assert.deepEqual(Buffer.from(await old.arrayBuffer()),pdf)

  gmailCalls=0
  assert.equal((await get(withFiles,0,'user-b')).status,404,'Another user cannot download')
  assert.equal((await get(withFiles,2)).status,404)
  assert.equal((await get(withFiles,-1)).status,404)
  assert.equal((await get(withFiles,'x')).status,404)
  assert.equal((await get('11111111-1111-4111-8111-111111111111',0)).status,404,'Messages without attachments have nothing to download')
  assert.equal(gmailCalls,0,'Rejected requests must not reach Gmail')

  const gone=await get(removed,0)
  assert.equal(gone.status,404);assert.match((await gone.json()).error,/no longer available in Gmail/)

  assert.equal(JSON.stringify(records),before,'Downloads must not write anything')
 } finally {globalThis.fetch=original;server.close();if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
})

test('Drive helpers pick linked tasks and subtasks, skip archived work and build Client/Project/Task folders',async()=>{
 const {driveName,linkedTaskIds,driveTargets,driveFolderPath,ensureDrivePath}=await import('../server/integrations/google-drive')
 assert.equal(driveName('  Q3\u0000 report\n'),'Q3 report');assert.equal(driveName(''),'Untitled');assert.equal(driveName('x'.repeat(300)).length,200)
 assert.deepEqual(linkedTaskIds({linked_task_id:'t2',linked_task_ids:['t1','t2']}),['t1','t2'])
 assert.deepEqual(linkedTaskIds({linked_task_id:'t9'}),['t9'],'Messages linked before schema v23 still count')
 assert.deepEqual(linkedTaskIds({}),[])
 const state:any={clients:[{id:'c1',name:'Acme Bank'},{id:'c2',name:'Old Co',archived:true}],projects:[{id:'p1',name:'POS Rollout'}],items:[
  {id:'t1',title:'Install terminals',clientId:'c1',projectId:'p1'},
  {id:'s2',title:'Site B',clientId:'c1',projectId:'p1',parentTaskId:'t1',subtaskOrder:2},
  {id:'s1',title:'Site A',clientId:'c1',projectId:'p1',parentTaskId:'t1',subtaskOrder:1},
  {id:'t2',title:'Archived client work',clientId:'c2',projectId:'p1'},
  {id:'t3',title:'Unrelated',clientId:'c1',projectId:'p1'}]}
 const targets=driveTargets(state,['t1','t2','missing'])
 assert.deepEqual(targets.map(t=>[t.id,t.kind]),[['t1','Task'],['s1','Subtask'],['s2','Subtask']],'Linked task first, then its subtasks in order; archived and unknown ids are skipped')
 assert.equal(targets[0].clientName,'Acme Bank');assert.equal(targets[0].projectName,'POS Rollout')
 assert.deepEqual(driveTargets(state,['s2']).map(t=>t.id),['s2'],'A linked subtask does not pull in its siblings')
 assert.deepEqual(driveFolderPath(state,'s1'),[{key:'client:c1',name:'Acme Bank'},{key:'project:c1:p1',name:'POS Rollout'},{key:'task:t1',name:'Install terminals'},{key:'task:s1',name:'Site A'}])
 assert.deepEqual(driveFolderPath({items:[{id:'x',title:'Loose'}]},'x').map(s=>s.name),['No client','No project','Loose'])
 assert.throws(()=>driveFolderPath(state,'nope'),/Task not found/)
 const calls:string[]=[]
 const fake={existingFolder:async(id:string,name:string)=>{calls.push(`check:${id}:${name}`);return id==='gone'?null:id},createFolder:async(name:string,parent?:string)=>{calls.push(`create:${name}:${parent}`);return `new-${name}`},upload:async()=>''}
 const result=await ensureDrivePath(fake as any,'root',{'client:c1':'keep','project:c1:p1':'gone'},driveFolderPath(state,'t1'))
 assert.equal(result.folderId,'new-Install terminals')
 assert.deepEqual(result.folders,{'client:c1':'keep','project:c1:p1':'new-POS Rollout','task:t1':'new-Install terminals'})
 assert.deepEqual(calls,['check:keep:Acme Bank','check:gone:POS Rollout','create:POS Rollout:keep','create:Install terminals:new-POS Rollout'],'Existing folders are reused, deleted ones recreated under the right parent')
})

test('Admin connects one shared Drive; attachments save into Client/Project/Task/Subtask folders and link on the task',async()=>{
 const oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY,original=globalThis.fetch
 process.env.TENANT_INTEGRATION_MASTER_KEY='f'.repeat(64)
 const {app,records,users,gmailAccounts,driveRows,prefs,state,getSaved}=fixture()
 users[0].role='Administrator';users[0].modules.push('settings')
 const server=app.listen(0)
 const address=server.address();if(!address||typeof address==='string')throw new Error('No port')
 const base=`http://127.0.0.1:${address.port}`,callback=`${base}/api/communications/gmail/callback`
 gmailAccounts.push({tenant_id:'tenant',platform_enabled:true,account_enabled:true,revision:'v1',encrypted_config:encryptSecret(JSON.stringify({clientId:'test.apps.googleusercontent.com',clientSecret:'fixture-secret',redirectUri:callback}),'tenant','gmail-oauth')})
 Object.assign(prefs[0],{gmail_labels:['L1'],gmail_config_revision:'v1',gmail_refresh_token:encryptSecret('gmail-refresh','tenant:user-a','gmail-refresh')})
 const mail=records[0];mail.attachments=[{name:'site-survey.pdf',partId:'1',mimeType:'application/pdf',size:9},{name:'photo.png',partId:'2',mimeType:'image/png',size:4}]
 const pdf=Buffer.from('%PDF-1.7'),png=Buffer.from('PNG!')
 // Fake Google: OAuth, Gmail and a Drive that remembers folders and files.
 const drive=new Map<string,any>();let nextId=0,uploads:any[]=[],tokenGrants:string[]=[],pendingUpload:any=null,identity='files@acme.example',grantedScope='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email'
 globalThis.fetch=(async(input:any,init:any={})=>{
  const url=new URL(String(input)),method=String(init.method||'GET')
  const json=(body:any,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}})
  if(url.hostname==='oauth2.googleapis.com'&&url.pathname==='/token'){const form=new URLSearchParams(String(init.body));tokenGrants.push(`${form.get('grant_type')}:${form.get('refresh_token')||form.get('code')}`)
   return form.get('grant_type')==='authorization_code'?json({access_token:'drive-access',refresh_token:'drive-refresh-secret',expires_in:3600,scope:grantedScope}):json({access_token:form.get('refresh_token')==='drive-refresh-secret'?'drive-access':'gmail-access',expires_in:3600})}
  if(url.pathname==='/oauth2/v3/userinfo')return json({email:identity,email_verified:true})
  if(url.hostname==='oauth2.googleapis.com'&&url.pathname==='/revoke')return json({})
  if(url.hostname==='gmail.googleapis.com'){
   if(url.pathname.endsWith('/attachments/att-pdf'))return json({data:pdf.toString('base64url'),size:pdf.length})
   return json({id:'secret-mail',payload:{mimeType:'multipart/mixed',parts:[{partId:'1',mimeType:'application/pdf',filename:'site-survey.pdf',body:{attachmentId:'att-pdf',size:pdf.length}},{partId:'2',mimeType:'image/png',filename:'photo.png',body:{data:png.toString('base64url'),size:png.length}}]}})
  }
  assert.equal(init.headers?.Authorization,'Bearer drive-access','Drive calls use the Drive token, never the Gmail one')
  if(url.pathname==='/drive/v3/files'&&method==='POST'){const body=JSON.parse(String(init.body)),id=`folder-${++nextId}`;drive.set(id,{...body,id});return json({id})}
  if(url.searchParams.get('alt')==='media'){const up=uploads.find(u=>u.id===decodeURIComponent(url.pathname.split('/').pop()||''));return up?new Response(up.bytes,{status:200,headers:{'content-type':up.type}}):json({error:{message:'File not found'}},404)}
  const file=/^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
  if(file){const found=drive.get(decodeURIComponent(file[1]));if(!found)return json({error:{message:'File not found'}},404)
   if(method==='PATCH'){found.name=JSON.parse(String(init.body)).name;return json({id:found.id})}
   return json({id:found.id,name:found.name,mimeType:found.mimeType,trashed:Boolean(found.trashed)})}
  if(url.pathname==='/upload/drive/v3/files'&&method==='POST'){pendingUpload={...JSON.parse(String(init.body)),type:init.headers['X-Upload-Content-Type']};return new Response('',{status:200,headers:{location:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u1'}})}
  if(url.pathname==='/upload/drive/v3/files'&&method==='PUT'){const id=`file-${++nextId}`;uploads.push({...pendingUpload,id,bytes:Buffer.from(init.body)});return json({id})}
  throw new Error(`Unexpected request ${method} ${url}`)
 }) as typeof fetch
 const local=(path:string,method='GET',body?:any,headers:Record<string,string>={})=>original(base+path,{method,headers:{'x-test-user':'user-a','x-test-role':'Administrator','content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined,redirect:'manual'})
 try {
  assert.deepEqual(await (await local('/api/account/drive')).json(),{gmailReady:true,connected:false,email:'',rootFolderUrl:'',reconnectRequired:false})
  assert.equal((await local('/api/account/drive/connect','POST',undefined,{'x-test-user':'user-b','x-test-role':'Contributor'})).status,403,'Only an account administrator connects Drive')
  assert.equal((await (await local('/api/communications/drive')).json()).available,false)

  // Connect: one shared Drive, through the existing Gmail OAuth client and callback address.
  const connect=await local('/api/account/drive/connect','POST');assert.equal(connect.status,200)
  const auth=new URL((await connect.json()).url)
  assert.equal(auth.searchParams.get('redirect_uri'),callback,'Reuses the Gmail redirect URI, so no Google Cloud redirect change is needed')
  assert.match(auth.searchParams.get('scope')||'',/auth\/drive\.file/);assert.doesNotMatch(auth.searchParams.get('scope')||'',/auth\/drive( |$)/,'Only the narrow drive.file scope is requested')
  const cookie=(connect.headers.get('set-cookie')||'').split(';')[0]
  assert.equal((await local(`/api/communications/gmail/callback?state=${auth.searchParams.get('state')}&code=x`,'GET',undefined,{cookie:'ba_drive_oauth=wrong'})).headers.get('location'),'/#drive=error','A bad cookie is not accepted')
  const connect2=await local('/api/account/drive/connect','POST'),auth2=new URL((await connect2.json()).url),cookie2=(connect2.headers.get('set-cookie')||'').split(';')[0]
  const done=await local(`/api/communications/gmail/callback?state=${auth2.searchParams.get('state')}&code=good-code`,'GET',undefined,{cookie:cookie2})
  assert.equal(done.status,303);assert.equal(done.headers.get('location'),'/#drive=connected')
  assert.equal(driveRows.length,1);assert.equal(driveRows[0].drive_email,'files@acme.example')
  assert.ok(!JSON.stringify(driveRows).includes('drive-refresh-secret'),'The refresh token is stored encrypted')
  const root=driveRows[0].root_folder_id;assert.equal(drive.get(root).name,'BA Client Ops Tracker')
  void cookie
  const status=await (await local('/api/account/drive')).json()
  assert.equal(status.connected,true);assert.equal(status.rootFolderUrl,`https://drive.google.com/drive/folders/${root}`)
  assert.equal((await (await local('/api/communications/drive')).json()).available,true)

  // Two tasks from the email, then a subtask under the first.
  const id='11111111-1111-4111-8111-111111111111'
  for(const title of ['Install terminals','Train staff']) assert.equal((await local(`/api/communications/${id}/create-task`,'POST',{title,description:'From email',clientId:'client',projectId:'project',assignedToUserId:'user-a'})).status,201)
  assert.equal(mail.linked_task_ids.length,2,'Every task made from the email is remembered privately')
  const [train,install]=getSaved().items
  assert.ok(!JSON.stringify(getSaved().items).includes(id),'Shared tasks still never hold the private message id')
  getSaved().items.push({id:'sub-1',title:'Site A',type:'Task',parentTaskId:install.id,clientId:'client',projectId:'project',subtaskOrder:1})
  const targets=(await (await local(`/api/communications/${id}/drive-targets`)).json()).targets
  assert.deepEqual(targets.map((t:any)=>t.title),['Install terminals','Site A','Train staff'])
  assert.equal((await local(`/api/communications/${id}/drive-targets`,'GET',undefined,{'x-test-user':'user-b'})).status,404,'Another user cannot see the targets of a private email')

  // A thread shows every message in it. The tasks were made from the message that was open, so an
  // attachment on an older message of the same thread still sees them; other threads and other owners do not.
  const base={tenant_id:'tenant',source:'Gmail',subject:'Re',body:'',sender:'x@example.com',status:'New',received_at:new Date().toISOString(),attachments:[{name:'older.pdf',partId:'1',mimeType:'application/pdf',size:9}]}
  records.push({...base,id:'22222222-2222-4222-8222-222222222222',owner_user_id:'user-a',external_id:'older-mail',thread_id:'thread-a'},
    {...base,id:'33333333-3333-4333-8333-333333333333',owner_user_id:'user-a',external_id:'other-thread-mail',thread_id:'thread-b'},
    {...base,id:'44444444-4444-4444-8444-444444444444',owner_user_id:'user-b',external_id:'bobs-mail',thread_id:'thread-a'})
  const older=(await (await local('/api/communications/22222222-2222-4222-8222-222222222222/drive-targets')).json()).targets
  assert.deepEqual(older.map((t:any)=>t.title),['Install terminals','Site A','Train staff'],'Older message of the same thread offers the thread tasks')
  assert.deepEqual((await (await local('/api/communications/33333333-3333-4333-8333-333333333333/drive-targets')).json()).targets,[],'A different thread does not')
  assert.deepEqual((await (await local('/api/communications/44444444-4444-4444-8444-444444444444/drive-targets','GET',undefined,{'x-test-user':'user-b'})).json()).targets,[],'Another user with the same thread id gets nothing')
  assert.equal((await local('/api/communications/33333333-3333-4333-8333-333333333333/attachments/0/drive','POST',{taskId:'sub-1'})).status,404,'A different thread cannot file into these tasks')

  // Save the PDF to the subtask.
  const saved=await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:'sub-1'})
  assert.equal(saved.status,201)
  const result=await saved.json()
  assert.equal(result.file.name,'site-survey.pdf');assert.equal(result.file.url,`https://drive.google.com/file/d/${result.file.id}/view`)
  const folderPath=(fid:string):string[]=>{const f=drive.get(fid);return f.parents?.[0]?[...folderPath(f.parents[0]),f.name]:[f.name]}
  assert.equal(uploads.length,1);assert.deepEqual(uploads[0].bytes,pdf);assert.equal(uploads[0].type,'application/pdf')
  assert.deepEqual(folderPath(uploads[0].parents[0]),['BA Client Ops Tracker','Client','Project','Install terminals','Site A'])
  const sub=getSaved().items.find((x:any)=>x.id==='sub-1')
  assert.equal(sub.driveFiles.length,1);assert.equal(sub.driveFiles[0].savedByName,'user-a')
  assert.match(getSaved().activity[0].text,/Saved “site-survey\.pdf” to Google Drive for subtask "Site A"/)
  assert.deepEqual(Object.keys(driveRows[0].folders).sort(),['client:client','project:client:project',`task:${install.id}`,'task:sub-1'].sort())
  assert.ok(!JSON.stringify([records,getSaved(),driveRows]).includes(pdf.toString('base64')),'File contents are never stored')

  // Same file again is refused; a second file reuses the folders.
  const again=await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:'sub-1'})
  assert.equal(again.status,409);assert.equal((await again.json()).code,'ALREADY_SAVED')
  const foldersBefore=[...drive.values()].filter(f=>f.mimeType==='application/vnd.google-apps.folder').length
  assert.equal((await local(`/api/communications/${id}/attachments/1/drive`,'POST',{taskId:'sub-1'})).status,201)
  assert.equal([...drive.values()].filter(f=>f.mimeType==='application/vnd.google-apps.folder').length,foldersBefore,'Existing folders are reused')

  // A renamed task renames its folder; a deleted folder is recreated.
  getSaved().items.find((x:any)=>x.id===train.id).title='Train branch staff'
  drive.delete(driveRows[0].folders['project:client:project'])
  assert.equal((await local(`/api/communications/${id}/attachments/1/drive`,'POST',{taskId:train.id})).status,201)
  assert.deepEqual(folderPath(uploads.at(-1).parents[0]),['BA Client Ops Tracker','Client','Project','Train branch staff'])

  // Renaming a task renames its existing folder instead of making a new one.
  const installFolder=driveRows[0].folders[`task:${install.id}`]
  getSaved().items.find((x:any)=>x.id===install.id).title='Install POS terminals'
  assert.equal((await local(`/api/communications/${id}/attachments/1/drive`,'POST',{taskId:install.id})).status,201)
  assert.equal(uploads.at(-1).parents[0],installFolder);assert.equal(drive.get(installFolder).name,'Install POS terminals')


  // Document Creation: pick a saved COR from Drive, and file generated documents under a task.
  const docs=(path:string,method='GET',body?:any,headers:Record<string,string>={})=>local(path,method,body,{'x-test-modules':'inbox,items,documents',...headers})
  assert.equal((await docs('/api/documents/drive')).status,200);assert.equal((await (await docs('/api/documents/drive')).json()).available,true)
  assert.equal((await local('/api/documents/drive')).status,403,'Document Creation access is required')
  assert.equal((await docs('/api/documents/drive','GET',undefined,{'x-test-role':'Viewer'})).status,403,'Viewers cannot use Drive from Document Creation')
  const savedFile=getSaved().items.find((x:any)=>x.id==='sub-1').driveFiles[0]
  const got=await docs(`/api/documents/drive/file?taskId=sub-1&fileId=${savedFile.id}`)
  assert.equal(got.status,200);assert.equal(got.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await got.arrayBuffer()),pdf,'The saved file comes back from Drive unchanged')
  assert.equal((await docs(`/api/documents/drive/file?taskId=sub-1&fileId=${savedFile.id}&maxBytes=3`)).status,413,'A file above the size limit is refused')
  assert.equal((await docs(`/api/documents/drive/file?taskId=${train.id}&fileId=${savedFile.id}`)).status,404,'A file is only served for the task it is listed on')
  assert.equal((await docs('/api/documents/drive/file?taskId=sub-1&fileId=not-listed')).status,404,'Arbitrary Drive ids are refused')
  assert.equal((await local(`/api/documents/drive/file?taskId=sub-1&fileId=${savedFile.id}`)).status,403)
  const docx=Buffer.concat([Buffer.from('PK'),Buffer.from('docx-body')]),brd={taskId:'sub-1',fileName:'BRD-Acme.docx',fileData:docx.toString('base64')}
  const filed=await docs('/api/documents/drive/save','POST',brd)
  assert.equal(filed.status,201);const filedBody=await filed.json()
  assert.deepEqual(filedBody.path,['Client','Project','Install POS terminals','Site A'])
  assert.deepEqual(uploads.at(-1).bytes,docx);assert.equal(uploads.at(-1).type,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert.equal(uploads.at(-1).name,'BRD-Acme.docx')
  const listed=getSaved().items.find((x:any)=>x.id==='sub-1').driveFiles.find((x:any)=>x.name==='BRD-Acme.docx')
  assert.equal(listed.source,'generated');assert.equal(listed.savedByName,'user-a')
  const twice=await docs('/api/documents/drive/save','POST',brd);assert.equal(twice.status,409);assert.equal((await twice.json()).code,'ALREADY_SAVED')
  for(const bad of [{...brd,fileName:'notes.exe'},{...brd,fileName:'x.docx',fileData:Buffer.from('not a zip').toString('base64')},{...brd,fileName:'x.pdf',fileData:docx.toString('base64')},{...brd,taskId:''},{...brd,fileData:'***'}])assert.equal((await docs('/api/documents/drive/save','POST',bad)).status,400)
  assert.equal((await docs('/api/documents/drive/save','POST',{...brd,taskId:'missing'})).status,404)
  assert.equal((await docs('/api/documents/drive/save','POST',brd,{'x-test-role':'Viewer'})).status,403)
  const clientRecord=getSaved().clients.find((x:any)=>x.id==='client');clientRecord.archived=true
  assert.equal((await docs('/api/documents/drive/save','POST',{...brd,fileName:'FSD.docx'})).status,409,'Archived work is not filed to');clientRecord.archived=false
  const uploadsBeforeFsd=uploads.length
  assert.equal((await docs('/api/documents/drive/save','POST',{...brd,fileName:'FSD.docx'})).status,201);assert.equal(uploads.length,uploadsBeforeFsd+1)

  // Reconnecting: refused without Drive access, refused if no longer an administrator, new root for another Google account.
  const reconnect=async()=>{const r=await local('/api/account/drive/connect','POST');const u=new URL((await r.json()).url);return local(`/api/communications/gmail/callback?state=${u.searchParams.get('state')}&code=good-code`,'GET',undefined,{cookie:(r.headers.get('set-cookie')||'').split(';')[0]})}
  const rootBefore=driveRows[0].root_folder_id,foldersBeforeReconnect={...driveRows[0].folders}
  grantedScope='https://www.googleapis.com/auth/userinfo.email'
  assert.equal((await reconnect()).headers.get('location'),'/#drive=denied','Unchecked Drive permission is refused')
  grantedScope='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email'
  { const r=await local('/api/account/drive/connect','POST');const u=new URL((await r.json()).url)
    users[0].role='Contributor'
    assert.equal((await local(`/api/communications/gmail/callback?state=${u.searchParams.get('state')}&code=good-code`,'GET',undefined,{cookie:(r.headers.get('set-cookie')||'').split(';')[0]})).headers.get('location'),'/#drive=error','Admin rights are re-checked when Google returns')
    users[0].role='Administrator' }
  assert.equal(driveRows[0].root_folder_id,rootBefore)
  assert.equal((await reconnect()).headers.get('location'),'/#drive=connected')
  assert.equal(driveRows[0].root_folder_id,rootBefore,'Same Google account keeps its root folder');assert.deepEqual(driveRows[0].folders,foldersBeforeReconnect)
  identity='other@acme.example'
  assert.equal((await reconnect()).headers.get('location'),'/#drive=connected')
  assert.notEqual(driveRows[0].root_folder_id,rootBefore,'Another Google account gets its own root folder');assert.deepEqual(driveRows[0].folders,{})

  // Refusals reach neither Gmail nor Drive.
  const uploadsBefore=uploads.length
  getSaved().items.push({id:'other',title:'Unrelated',type:'Task',clientId:'client',projectId:'project'})
  assert.equal((await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:'other'})).status,404,'Only tasks made from this email')
  assert.equal((await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:'sub-1'},{'x-test-user':'user-b'})).status,404,'Not another user’s email')
  assert.equal((await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:'sub-1'},{'x-test-role':'Viewer'})).status,403,'Viewers cannot save')
  assert.equal((await local(`/api/communications/${id}/attachments/9/drive`,'POST',{taskId:install.id})).status,404)
  assert.equal(uploads.length,uploadsBefore)

  // Disconnect.
  assert.equal((await local('/api/account/drive','DELETE')).status,200)
  assert.equal(driveRows.length,0);assert.equal((await (await local('/api/communications/drive')).json()).available,false)
  assert.equal((await local(`/api/communications/${id}/attachments/0/drive`,'POST',{taskId:install.id})).status,409)
  assert.ok(tokenGrants.includes('authorization_code:good-code'))
 } finally {globalThis.fetch=original;server.close();if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
})
