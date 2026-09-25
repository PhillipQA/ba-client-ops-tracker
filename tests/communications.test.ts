import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerCommunications } from '../server/integrations/communications'

function fixture() {
  const records:any[]=[{id:'11111111-1111-4111-8111-111111111111',tenant_id:'tenant',owner_user_id:'user-a',source:'Gmail',external_id:'secret-mail',thread_id:'thread-a',subject:'Private subject',body:'Private full email thread',sender:'private@example.com',status:'New',received_at:new Date().toISOString()}]
  const prefs:any[]=[{tenant_id:'tenant',user_id:'user-a',discord_user_id:'123456789012345678',discord_capture_mentions:true},{tenant_id:'tenant',user_id:'user-b',discord_user_id:'234567890123456789',discord_capture_mentions:true}]
  let saved:any
  const state={clients:[{id:'client',name:'Client'}],projects:[{id:'project',name:'Project'}],accounts:[{id:'user-a',name:'Alice',status:'Active',role:'Contributor'},{id:'user-b',name:'Bob',status:'Active',role:'Contributor'}],items:[]}
  class Query {
    conditions:((x:any)=>boolean)[]=[]; action='read'; value:any; many=true
    constructor(public table:string) {}
    select(_columns='*') {return this}
    eq(key:string,value:any){this.conditions.push(x=>x[key]===value);return this}
    in(key:string,values:any[]){this.conditions.push(x=>values.includes(x[key]));return this}
    order(){return this}
    limit(){return this}
    insert(value:any){this.action='insert';this.value=value;return this}
    update(value:any){this.action='update';this.value=value;return this}
    upsert(value:any){this.action='upsert';this.value=value;return this}
    maybeSingle(){this.many=false;return this.run()}
    single(){this.many=false;return this.run()}
    then(resolve:any,reject:any){return this.run().then(resolve,reject)}
    async run(){const rows=this.table==='user_communications'?records:prefs
      if(this.action==='insert'){const record={id:crypto.randomUUID(),...this.value};rows.push(record);return {data:this.many?null:record,error:null}}
      if(this.action==='update'){const found=rows.filter(x=>this.conditions.every(c=>c(x)));for(const row of found)Object.assign(row,this.value);return {data:this.many?null:found[0]||null,error:null}}
      if(this.action==='upsert'){const found=rows.find(x=>x.tenant_id===this.value.tenant_id && x.user_id===this.value.user_id);if(found)Object.assign(found,this.value);else rows.push(this.value);return {data:null,error:null}}
      const matched=rows.filter(x=>this.conditions.every(c=>c(x)));return {data:this.many?matched:matched[0]||null,error:null}
    }
  }
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{const id=String(req.headers['x-test-user']||'user-a');req.authUser={id,organizationId:'tenant',name:id,role:String(req.headers['x-test-role']||'Contributor'),modules:['inbox','items'],status:'Active'};next()})
  const hub=registerCommunications(app,{db:{from:(table:string)=>new Query(table)},requireAuth:(_req,_res,next)=>next(),requireTenant:(_req,_res,next)=>next(),sessionFromRequest:()=>({token:'',user:null}),load:async()=>({data:state}),commit:async(_tenant,next)=>{saved=next},openStatus:()=> 'Open'})
  return {app,records,hub,getSaved:()=>saved}
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
