import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GithubHub from '../src/features/integrations/GithubHub'
import WorkHub from '../src/features/work-hub/WorkHub'
import { WORK_HUB_TABS } from '../src/features/integrations/github-model'
import { registerGithub } from '../server/integrations/github'
import { decryptSecret } from '../server/integrations/tenant-integrations'
import { linkedTaskSchedule } from '../server/integrations/linked-task-fields'

const TOKEN_A='github_pat_'+ 'a'.repeat(30),TOKEN_B='github_pat_'+ 'b'.repeat(30)
const now=new Date().toISOString()
function issue(number: number,extra: any={}) { return {id:10000+number,number,title:`Inventory ticket ${number}`,body:'PRIVATE body for QA',html_url:`https://github.com/acme/pos/issues/${number}`,state:'open',state_reason:null,user:{login:'alice'},assignees:[{login:'alice'}],labels:[{name:'bug'}],comments:0,created_at:'2011-01-01T00:00:00Z',updated_at:now,...extra} }
async function fixture(run: (f:any)=>Promise<void>,budget=12) {
  const oldFetch=globalThis.fetch,oldKey=process.env.TENANT_INTEGRATION_MASTER_KEY
  process.env.TENANT_INTEGRATION_MASTER_KEY='a'.repeat(64)
  const tables:Record<string,any[]>={user_github_connections:[],user_github_issues:[]}
  const states:Record<string,any>={tenant:{clients:[{id:'client',name:'Acme'}],projects:[{id:'project',name:'POS'}],accounts:[{id:'user-a',name:'Alice',role:'Contributor',status:'Active'},{id:'user-b',name:'Bob',role:'Contributor',status:'Active'}],items:[{id:'existing',title:'Existing task',type:'Task',status:'Open',clientId:'client',projectId:'project'},{id:'child',title:'Retest subtask',parentTaskId:'existing',type:'Task',status:'Open',clientId:'client',projectId:'project'}]},other:{clients:[],projects:[],accounts:[],items:[]}}
  let commitFailure=false,lostResponse=false,remoteFailure=0,hold:Promise<void>|null=null,missingTable=false
  const provider:any[]=[];const repositories:Record<string,any[]>={'acme/pos':[issue(1)],'acme/reports':[]};let repositoryCatalog:any[]=[{full_name:'acme/pos',has_issues:true,private:true},{full_name:'acme/reports',has_issues:true,private:false}]
  const comments=Array.from({length:6},(_,i)=>({id:i+1,user:{login:'dev'},body:`Comment ${i+1}`,updated_at:now}))
  class Query {
    checks:((r:any)=>boolean)[]=[];action='read';value:any;conflict:string[]=[];columns='*';many=true;head=false;start=0;end=Infinity;orders:{key:string;ascending:boolean}[]=[]
    constructor(public table:string){}
    select(columns='*',options:any={}){this.columns=columns;this.head=Boolean(options.head);return this}
    eq(k:string,v:any){this.checks.push(r=>r[k]===v);return this}
    is(k:string,v:any){this.checks.push(r=>r[k]===v || v===null && r[k]===undefined);return this}
    in(k:string,v:any[]){this.checks.push(r=>v.includes(r[k]));return this}
    contains(k:string,v:any[]){this.checks.push(r=>v.every(x=>(r[k] || []).includes(x)));return this}
    or(_value:string){this.checks.push(r=>r.created_by_me || r.assigned_to_me);return this}
    ilike(k:string,pattern:string){const term=pattern.slice(1,-1).replace(/\\([\\%_])/g,'$1').toLowerCase();this.checks.push(r=>String(r[k] || '').toLowerCase().includes(term));return this}
    order(key:string,options:{ascending:boolean}){this.orders.push({key,ascending:options.ascending});return this}
    range(start:number,end:number){this.start=start;this.end=end;return this}
    update(value:any){this.action='update';this.value=value;return this}
    upsert(value:any,options:any){this.action='upsert';this.value=value;this.conflict=options.onConflict.split(',');return this}
    maybeSingle(){this.many=false;return this.run()}
    then(resolve:any,reject:any){return this.run().then(resolve,reject)}
    async run(){
      if(missingTable)return {data:null,error:{code:'42P01'}}
      const rows=tables[this.table]
      if(!rows)throw new Error(`Unexpected table ${this.table}`)
      if(this.action==='upsert'){
        for(const incoming of Array.isArray(this.value)?this.value:[this.value]){
          const found=rows.find(r=>this.conflict.every(k=>r[k]===incoming[k]))
          if(found)Object.assign(found,structuredClone(incoming))
          else rows.push({id:crypto.randomUUID(),qa_status:'Not started',linked_task_id:null,available:true,...structuredClone(incoming)})
        }
        return {data:null,error:null}
      }
      const matched=rows.filter(r=>this.checks.every(check=>check(r)))
      if(this.action==='update')for(const row of matched)Object.assign(row,structuredClone(this.value))
      matched.sort((a,b)=>{for(const o of this.orders){const result=String(a[o.key]).localeCompare(String(b[o.key]));if(result)return o.ascending?result:-result}return 0})
      if(this.start>0 && this.start>=matched.length)return {data:null,count:null,error:{code:'PGRST103'}}
      const projection=(r:any)=>structuredClone(this.columns==='*'?r:Object.fromEntries(this.columns.split(',').map(k=>[k,r[k]])))
      return {data:this.head?null:this.many?matched.slice(this.start,this.end+1).map(projection):matched[0]?projection(matched[0]):null,count:matched.length,error:null}
    }
  }
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.authUser={id:String(req.headers['x-user'] || 'user-a'),organizationId:String(req.headers['x-tenant'] || 'tenant'),role:String(req.headers['x-role'] || 'Contributor'),modules:req.headers['x-no-tasks']?['inbox']:['inbox','items']};next()})
  const pass=(_req:any,_res:any,next:any)=>next()
  registerGithub(app,{db:{from:(table:string)=>new Query(table)},requireAuth:pass,requireTenant:pass,guard:(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next()},load:async(id)=>({data:structuredClone(states[id])}),commit:async(id,next)=>{if(commitFailure)throw new Error('Commit failed');states[id]=structuredClone(next);if(lostResponse)throw new Error('Response lost')},openStatus:()=> 'Open',requestBudget:budget})
  const server=app.listen(0),base=`http://127.0.0.1:${(server.address() as any).port}/api/work-hub/github`
  const ask=async(path:string,method='GET',body?:any,who='user-a',tenant='tenant',role='Contributor')=>{const response=await oldFetch(base+path,{method,headers:{'content-type':'application/json','x-user':who,'x-tenant':tenant,'x-role':role},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json(),headers:response.headers}}
  globalThis.fetch=(async(input:any,options:any)=>{
    if(!String(input).startsWith('https://api.github.com'))return oldFetch(input,options)
    const url=new URL(String(input)),token=options.headers.Authorization.slice(7),login=token===TOKEN_B?'bob':'alice'
    provider.push({url:String(url),method:options.method || 'GET',token})
    if(hold)await hold
    const json=(value:any,status=200,headers:any={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}})
    if(remoteFailure)return json({message:`Sensitive provider echo ${TOKEN_A}`},remoteFailure,remoteFailure===429?{'retry-after':'90'}:{})
    if(url.pathname==='/user')return json({id:login==='alice'?42:43,login})
    if(url.pathname==='/user/repos'){const p=Number(url.searchParams.get('page')||1);return json(repositoryCatalog.slice((p-1)*100,p*100))}
    const route=url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(?:\/issues(?:\/(\d+)(?:\/(comments))?)?)?$/)
    if(!route)return json({},404)
    const repo=decodeURIComponent(route[1]);if(!(repo in repositories))return json({},404)
    if(!url.pathname.includes('/issues'))return json({full_name:repo,has_issues:true})
    const number=Number(route[2]),values=repositories[repo]
    if(number){const found=values.find(i=>i.number===number);if(!found)return json({},404);if(route[3]){const page=Number(url.searchParams.get('page')||1);return json(comments.slice((page-1)*5,page*5))}return json(found)}
    const state=url.searchParams.get('state'),creator=url.searchParams.get('creator'),assignee=url.searchParams.get('assignee'),since=url.searchParams.get('since'),page=Number(url.searchParams.get('page')||1)
    const filtered=values.filter(i=>(!state || i.state===state) && (!creator || i.user.login===creator) && (!assignee || i.assignees.some((a:any)=>a.login===assignee)) && (!since || i.updated_at>=since)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||a.id-b.id)
    return json(filtered.slice((page-1)*100,page*100))
  }) as typeof fetch
  const connect=async(who='user-a',token=TOKEN_A)=>{assert.equal((await ask('/connection','PUT',{token},who)).status,200)}
  const select=async(names=['acme/pos'],who='user-a')=>{const response=await ask('/repositories','PUT',{repositories:names.map(fullName=>({fullName,clientId:'client',projectId:'project'}))},who);assert.equal(response.status,200,JSON.stringify(response.body))}
  const sync=async(who='user-a')=>{let response:any;for(let i=0;i<50;i++){response=await ask('/sync','POST',{},who);assert.equal(response.status,200,JSON.stringify(response.body));if(!response.body.hasMore)return response.body}throw new Error('Sync did not complete')}
  try{await run({ask,connect,select,sync,tables,states,repositories,provider,comments,setRemoteFailure:(v:number)=>{remoteFailure=v},setHold:(v:Promise<void>|null)=>{hold=v},setCommitFailure:(v:boolean)=>{commitFailure=v},setLostResponse:(v:boolean)=>{lostResponse=v},setMissingTable:(v:boolean)=>{missingTable=v},setCatalog:(v:any[])=>{repositoryCatalog=v}})}
  finally{globalThis.fetch=oldFetch;await new Promise<void>(resolve=>server.close(()=>resolve()));if(oldKey===undefined)delete process.env.TENANT_INTEGRATION_MASTER_KEY;else process.env.TENANT_INTEGRATION_MASTER_KEY=oldKey}
}

test('GitHub personal tokens are validated, encrypted for the owning user, and absent from public settings',async()=>fixture(async(f:any)=>{
  await f.connect();const stored=f.tables.user_github_connections[0]
  assert.notEqual(stored.encrypted_token,TOKEN_A);assert.equal(decryptSecret(stored.encrypted_token,'tenant:user-a','github-token'),TOKEN_A)
  assert.throws(()=>decryptSecret(stored.encrypted_token,'tenant:user-b','github-token'))
  const summary=await f.ask('/connection');assert.equal(summary.body.connected,true);assert.equal(summary.body.login,'alice');assert.ok(!JSON.stringify(summary.body).includes(TOKEN_A));assert.ok(!JSON.stringify(summary.body).includes('encrypted_token'))
  assert.equal((await f.ask('/connection','PUT',{token:'invalid'})).status,400);assert.equal(f.tables.user_github_connections[0].encrypted_token,stored.encrypted_token)
  assert.equal((await f.ask('/connection','GET',undefined,'user-b')).body.connected,false)
}))

test('repository selection validates access, unique names, mappings and owner/repository format',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select()
  const selected=await f.ask('/connection');assert.deepEqual(selected.body.repositories,[{fullName:'acme/pos',clientId:'client',projectId:'project'}])
  for(const repositories of [[{fullName:'https://evil.example',clientId:'',projectId:''}],[{fullName:'acme/missing'}],[{fullName:'acme/pos',clientId:'another-tenant'}],[{fullName:'acme/pos'},{fullName:'acme/pos'}]])assert.ok((await f.ask('/repositories','PUT',{repositories})).status>=400)
  assert.deepEqual((await f.ask('/connection')).body.repositories,selected.body.repositories)
}))

test('sync imports created or assigned issues once, excludes pull requests and unrelated issues, and keeps old open tickets',async()=>fixture(async(f:any)=>{
  f.repositories['acme/pos']=[issue(1),issue(2,{user:{login:'dev'},assignees:[{login:'alice'}]}),issue(3,{user:{login:'alice'},assignees:[],state:'closed'}),issue(4,{user:{login:'dev'},assignees:[{login:'dev'}]}),issue(5,{pull_request:{url:'pull'}}),issue(6,{state:'closed',updated_at:'2012-01-01T00:00:00Z'})]
  await f.connect();await f.select();await f.sync()
  assert.deepEqual(f.tables.user_github_issues.map((i:any)=>i.number).sort(),[1,2,3]);assert.equal(f.tables.user_github_issues[0].created_at,'2011-01-01T00:00:00Z')
  assert.equal((await f.ask('/tickets')).body.total,2);assert.equal((await f.ask('/tickets?view=created&state=all')).body.total,2);assert.equal((await f.ask('/tickets?view=assigned')).body.total,2)
  assert.equal((await f.ask('/tickets?label=bug')).body.total,2);assert.equal((await f.ask('/tickets?label=missing')).body.total,0);assert.equal((await f.ask('/tickets?q=Inventory%25')).body.total,0)
  await f.sync();assert.equal(f.tables.user_github_issues.length,3);assert.ok(f.provider.every((r:any)=>r.method==='GET'))
}))

test('paged sync continues after its request budget and retains QA status and task links during refresh',async()=>fixture(async(f:any)=>{
  f.repositories['acme/pos']=Array.from({length:101},(_,i)=>issue(i+1));await f.connect();await f.select()
  const first=await f.ask('/sync','POST',{});assert.equal(first.body.hasMore,true);assert.equal(f.tables.user_github_issues.length,101)
  const ticket=f.tables.user_github_issues[0];assert.equal((await f.ask(`/tickets/${ticket.id}`,'PATCH',{qaStatus:'Needs retest'})).status,200)
  assert.equal((await f.ask(`/tickets/${ticket.id}/link-task`,'POST',{taskId:'child'})).status,200)
  await f.sync();assert.equal(f.tables.user_github_issues.length,101);assert.equal(ticket.qa_status,'Needs retest');assert.equal(ticket.linked_task_id,'child')
  assert.ok(f.provider.some((r:any)=>new URL(r.url).searchParams.get('page')==='2'))
  assert.equal((await f.ask('/tickets?page=2&pageSize=5')).body.items.length,5)
  assert.equal((await f.ask('/tickets?page=500&pageSize=5')).body.total,101)
  assert.equal((await f.ask('/tickets?qa=Needs%20retest')).body.total,1)
  assert.equal((await f.ask('/sync','POST',{auto:true})).body.requests,0)
},2))

test('sync reconciles closure and reassignment without changing local QA status or task state',async()=>fixture(async(f:any)=>{
  f.repositories['acme/pos']=[issue(1),issue(2,{user:{login:'dev'}})];await f.connect();await f.select();await f.sync()
  const ticket=f.tables.user_github_issues.find((i:any)=>i.number===1);await f.ask(`/tickets/${ticket.id}`,'PATCH',{qaStatus:'Needs retest'})
  f.repositories['acme/pos'][0].state='closed';f.repositories['acme/pos'][0].updated_at='2012-01-01T00:00:00Z'
  f.repositories['acme/pos'][1].assignees=[]
  await f.sync();assert.equal(ticket.state,'closed');assert.equal(ticket.qa_status,'Needs retest');assert.equal((await f.ask('/tickets')).body.total,0);assert.equal((await f.ask('/tickets?state=closed')).body.total,1)
  assert.equal(f.states.tenant.items[0].status,'Open')
}))

test('tokens and imported tickets stay isolated across users, tenants and GitHub account changes',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();await f.sync();const id=f.tables.user_github_issues[0].id
  assert.equal((await f.ask('/tickets','GET',undefined,'user-b','tenant','Administrator')).body.total,0)
  for(const [path,method,body] of [[`/tickets/${id}`,'GET',undefined],[`/tickets/${id}`,'PATCH',{qaStatus:'Passed'}],[`/tickets/${id}/link-task`,'POST',{taskId:'existing'}],[`/tickets/${id}/create-task`,'POST',{}]])assert.equal((await f.ask(path as string,method as string,body,'user-b')).status,404)
  assert.equal((await f.ask(`/tickets/${id}`,'GET',undefined,'user-a','other')).status,404)
  await f.connect('user-b',TOKEN_B);await f.select(['acme/pos'],'user-b');await f.sync('user-b');assert.equal((await f.ask('/tickets','GET',undefined,'user-b')).body.total,0)
  await f.ask('/connection','DELETE');assert.equal((await f.ask('/connection')).body.connected,false);assert.equal((await f.ask('/tickets')).body.total,1)
  await f.connect('user-a',TOKEN_B);assert.equal((await f.ask('/connection')).body.repositories.length,0);await f.select();assert.equal((await f.ask('/tickets')).body.total,0)
  assert.ok(f.tables.user_github_issues.some((i:any)=>i.id===id),'old account cache retained privately')
}))

test('task creation shares only reviewed fields and cannot create a duplicate on repeated submission',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();await f.sync();const id=f.tables.user_github_issues[0].id
  const body={title:'Retest inventory',description:'Shared summary',clientId:'client',projectId:'project',assignedToUserId:'user-b'}
  const created=await f.ask(`/tickets/${id}/create-task`,'POST',body);assert.equal(created.status,201,JSON.stringify(created.body));assert.equal(created.body.task.assignedToUserId,'user-b')
  assert.equal(f.states.tenant.items[0].description,'Shared summary');assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes('PRIVATE'));assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes(id));assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes(TOKEN_A))
  assert.equal((await f.ask(`/tickets/${id}/create-task`,'POST',body)).status,409);assert.equal(f.states.tenant.items.length,3)
  assert.equal((await f.ask(`/tickets/${id}/link-task`,'POST',{taskId:''})).status,200);assert.equal((await f.ask(`/tickets/${id}/link-task`,'POST',{taskId:'child'})).body.ticket.linked_task_id,'child')
  assert.equal((await f.ask(`/tickets/${id}/link-task`,'POST',{taskId:'other-tenant-task'})).status,404)
  assert.equal((await f.ask(`/tickets/${id}/create-task`,'POST',body,'user-a','tenant','Viewer')).status,403)
}))

test('task creation saves the chosen schedule and waiting on, and rejects invalid values',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();await f.sync();const id=f.tables.user_github_issues[0].id
  const base={title:'Scheduled retest',description:'Summary',clientId:'client',projectId:'project',assignedToUserId:'user-b'}
  for(const bad of [{waitingOn:'Nobody'},{startDate:'2026-13-01'},{dueDate:'2026-02-30'},{followUpDate:'tomorrow'},{startDate:'2026-10-21',dueDate:'2026-10-20'}]){
    const rejected=await f.ask(`/tickets/${id}/create-task`,'POST',{...base,...bad});assert.equal(rejected.status,400,JSON.stringify(bad));assert.equal(f.tables.user_github_issues[0].linked_task_id,null)
  }
  const created=await f.ask(`/tickets/${id}/create-task`,'POST',{...base,waitingOn:'Client',startDate:'2026-10-20',dueDate:'2026-10-24',followUpDate:'2026-10-22'});assert.equal(created.status,201,JSON.stringify(created.body))
  const saved=f.states.tenant.items[0];assert.equal(saved.waitingOn,'Client');assert.equal(saved.startDate,'2026-10-20');assert.equal(saved.dueDate,'2026-10-24');assert.equal(saved.followUpDate,'2026-10-22')
}))

test('failed task commits release the reservation; lost successful responses keep a recoverable link',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();await f.sync();const ticket=f.tables.user_github_issues[0],body={title:'Retest',description:'Summary',clientId:'client',projectId:'project',assignedToUserId:'user-a'}
  f.setCommitFailure(true);assert.equal((await f.ask(`/tickets/${ticket.id}/create-task`,'POST',body)).status,503);assert.equal(ticket.linked_task_id,null)
  f.setCommitFailure(false);f.setLostResponse(true);const saved=await f.ask(`/tickets/${ticket.id}/create-task`,'POST',body);assert.equal(saved.status,201);assert.equal(ticket.linked_task_id,saved.body.task.id)
  assert.equal((await f.ask(`/tickets/${ticket.id}/create-task`,'POST',body)).status,409)
}))

test('latest comment is fetched from the final comment page without exposing private provider data',async()=>fixture(async(f:any)=>{
  f.repositories['acme/pos'][0].comments=6;await f.connect();await f.select();await f.sync();const id=f.tables.user_github_issues[0].id
  const detail=await f.ask(`/tickets/${id}`);assert.equal(detail.status,200);assert.equal(detail.body.comments.at(-1).body,'Comment 6');assert.ok(f.provider.some((p:any)=>p.url.includes('comments?per_page=5&page=2')))
  assert.ok(!JSON.stringify(detail.body).includes(TOKEN_A));assert.equal(detail.headers.get('cache-control'),'no-store')
}))

test('rate limits pause sync with retry guidance; revoked tokens preserve cached tickets',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();await f.sync();const id=f.tables.user_github_issues[0].id
  f.setRemoteFailure(429);const limited=await f.ask('/sync','POST',{});assert.equal(limited.status,429);assert.equal(limited.body.retryAfterSeconds,90);assert.equal(limited.headers.get('retry-after'),'90');assert.ok(!JSON.stringify(limited.body).includes(TOKEN_A))
  const calls=f.provider.length;assert.equal((await f.ask('/sync','POST',{})).status,429);assert.equal(f.provider.length,calls)
  f.tables.user_github_connections[0].retry_after=null;f.setRemoteFailure(401);assert.equal((await f.ask('/sync','POST',{})).status,409);assert.equal((await f.ask('/tickets')).body.total,1)
  const detail=await f.ask(`/tickets/${id}`);assert.equal(detail.status,200);assert.match(detail.body.commentError,/expired or was revoked/)
}))

test('simultaneous sync and settings mutation do not corrupt the owning connection',async()=>fixture(async(f:any)=>{
  await f.connect();await f.select();let release!:()=>void;f.setHold(new Promise<void>(resolve=>{release=resolve}))
  const pending=f.ask('/sync','POST',{});while(!f.provider.some((p:any)=>p.url.includes('/issues?')))await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal((await f.ask('/connection','DELETE')).status,409);assert.equal((await f.ask('/connection','GET',undefined,'user-b')).status,200)
  release();f.setHold(null);assert.equal((await pending).status,200);assert.equal((await f.ask('/connection')).body.connected,true)
}))

test('repository discovery supports pagination and unavailable storage gives migration guidance',async()=>fixture(async(f:any)=>{
  await f.connect();f.setCatalog(Array.from({length:101},(_,i)=>({full_name:`acme/repo-${i}`,has_issues:true})))
  const first=await f.ask('/repositories');assert.equal(first.body.repositories.length,100);assert.equal(first.body.hasMore,true)
  const next=await f.ask('/repositories?page=2');assert.equal(next.body.repositories.length,1);assert.equal(next.body.hasMore,false)
  f.setMissingTable(true);const result=await f.ask('/connection');assert.equal(result.status,503);assert.match(result.body.error,/schema-v19/)
}))

test('Work Hub exposes exactly Email, Discord, GitHub and Manual Logs with ticket filters',()=>{
  const currentUser:any={id:'user-a',name:'Alice',role:'Contributor',modules:['inbox','items'],organizationId:'tenant'},props={clients:[],projects:[],accounts:[],tasks:[],currentUser,onTaskCreated:async()=>{}}
  assert.deepEqual(WORK_HUB_TABS.map(t=>t.label),['Email','Discord','GitHub / GitLab','Manual Logs'])
  const hub=renderToStaticMarkup(createElement(WorkHub,props));assert.match(hub,/>Work Hub</);assert.match(hub,/>Email</);assert.match(hub,/>GitHub \/ GitLab</);assert.match(hub,/>Manual Logs</);assert.ok(!hub.includes('My Communications'))
  const github=renderToStaticMarkup(createElement(GithubHub,props));assert.match(github,/Assigned to me/);assert.match(github,/Created by me/);assert.match(github,/All my tickets/);assert.match(github,/My GitHub settings/);assert.match(github,/QA status/)
})

test('linked task waiting on follows the account options',()=>{
  const state={taskSettings:{statuses:[],visibleColumns:['status'],waitingOn:[{id:'vendor',label:'Vendor',done:false},{id:'me',label:'Me',done:false},{id:'done',label:'Finished',done:true}]}}
  assert.equal(linkedTaskSchedule({},state).waitingOn,'Vendor')
  assert.equal(linkedTaskSchedule({waitingOn:'Me'},state).waitingOn,'Me')
  assert.throws(()=>linkedTaskSchedule({waitingOn:'Developer'},state),/valid waiting on/)
  assert.equal(linkedTaskSchedule({waitingOn:'Developer'}).waitingOn,'Developer')
})
