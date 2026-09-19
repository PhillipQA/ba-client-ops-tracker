import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import PizZip from 'pizzip'
import { encryptSecret, decryptSecret, encryptionKey, integrationSummary, createIntegrationStore, registerIntegrationRoutes } from '../tenant-integrations'
import { registerPlatformSettings } from '../platform-settings'
import { requirePlatformAdmin } from '../platform-auth'
process.env.TENANT_INTEGRATION_MASTER_KEY = 'ab'.repeat(32)
const secretA = 'sk-test-account-a-credential-1234', secretB = 'sk-test-account-b-credential-5678'
function memoryDatabase() {
  const tables = new Map<string, any[]>()
  return { tables, from(table: string) {
    if (!tables.has(table)) tables.set(table, [])
    let filters: [string,any][] = [], op = 'select', payload: any, single = false, fields = '*'
    const q: any = {
      select(v = '*') { fields = v; return q }, eq(k: string,v: any) { filters.push([k,v]);return q },
      maybeSingle() { single = true;return q }, update(v: any) { op='update';payload=v;return q },
      upsert(v: any) { op='upsert';payload=v;return q }, insert(v: any) { op='insert';payload=v;return q }, delete() { op='delete';return q },
      then(resolve: any,reject: any) {
        try {
          const rows = tables.get(table)!, matches = (r: any) => filters.every(([k,v]) => r[k] === v)
          if (op === 'insert' || op === 'upsert') {
            const index = rows.findIndex(r => r.tenant_id === payload.tenant_id && r.integration_type === payload.integration_type)
            if ((index >= 0 && op === 'insert') || (payload.integration_type === 'discord' && rows.some(r => r.tenant_id !== payload.tenant_id && r.provider_identity === payload.provider_identity))) return resolve({ data:null,error:{code:'23505'} })
            if(index >= 0) rows[index] = {...payload}; else rows.push({...payload})
          }
          if(op === 'delete') tables.set(table, rows.filter(r => !matches(r)))
          if(op === 'update') rows.filter(matches).forEach(r => Object.assign(r,payload))
          const found = tables.get(table)!.filter(matches).map(r => fields === '*' ? {...r} : Object.fromEntries(fields.split(',').map(k=>[k,r[k]])))
          return resolve({ data:single ? found[0] || null : found, error:null })
        } catch(e) { return reject(e) }
      }
    };return q
  } }
}
test('AES-GCM rejects cross-tenant, cross-provider, wrong-key and tampered ciphertext', () => {
  const encrypted = encryptSecret(secretA,'a','openai')
  assert.equal(decryptSecret(encrypted,'a','openai'), secretA)
  assert.notEqual(encrypted,encryptSecret(secretA,'a','openai'))
  assert.throws(()=>decryptSecret(encrypted,'b','openai'))
  assert.throws(()=>decryptSecret(encrypted,'a','discord'))
  assert.throws(()=>decryptSecret(encrypted,'a','openai',Buffer.alloc(32)))
  const parts=encrypted.split('.');parts[2]=Buffer.alloc(16).toString('base64')
  assert.throws(()=>decryptSecret(parts.join('.'),'a','openai'))
  assert.throws(()=>encryptionKey('short'))
})
test('summaries exclude secrets and encrypted ciphertext',()=>{
  const summary=integrationSummary({encrypted_secret:'sensitive',secret_suffix:'1234',is_enabled:true,config_json:{model:'x'}},'openai')
  assert.equal(summary.maskedKey,'••••••••1234'); assert(!JSON.stringify(summary).includes('sensitive'))
})
test('store preserves tenant isolation through update, disable, removal and reconstruction', async()=>{
  const db=memoryDatabase(),store=createIntegrationStore(db)
  await store.save('a','openai',{secret:secretA,enabled:true,config:{model:'model-a'}})
  await store.save('b','openai',{secret:secretB,enabled:true,config:{model:'model-b'}})
  assert(!JSON.stringify(db.tables.get('tenant_integrations')).includes(secretA))
  assert.equal((await createIntegrationStore(db).active('a','openai'))?.secret,secretA)
  await store.save('a','openai',{enabled:false})
  assert.equal(await store.active('a','openai'),null)
  assert.equal((await store.active('b','openai'))?.secret,secretB)
  await assert.rejects(()=>store.save('b','openai',{secret:secretA},true))
  await store.remove('a','openai');assert.equal(await store.row('a','openai'),null)
  assert.equal((await store.active('b','openai'))?.config.model,'model-b')
})
test('Discord duplicate bot identity cannot be assigned across tenants', async()=>{
  const original=globalThis.fetch
  globalThis.fetch=async()=>new Response(JSON.stringify({bot:true,id:'123456789012345678'}),{status:200})
  try {
    const store=createIntegrationStore(memoryDatabase())
    await store.save('a','discord',{secret:'a'.repeat(40)})
    await assert.rejects(()=>store.save('b','discord',{secret:'b'.repeat(40)}), /already assigned/)
    await store.save('a','discord',{secret:'c'.repeat(40),enabled:false})
    assert.equal(await store.active('a','discord'),null)
  } finally { globalThis.fetch=original }
})
test('real HTTP routes scope writes from authenticated tenant and deny unauthorized users', async()=>{
  const db=memoryDatabase(), store=createIntegrationStore(db), app=express()
  app.use(express.json())
  const auth:any=(req:any,res:any,next:any)=>{
    const role=req.get('x-test-user')
    if (!role) return res.sendStatus(401)
    req.authUser={id:'user',organizationId:req.get('x-test-tenant')||'a',role:role==='viewer'?'Viewer':'Administrator',modules:role==='no-settings'?[]:['settings','documents'],accountType:role==='platform'?'platform':'tenant',isPlatformAdmin:role==='platform'};next()
  }
  const tenant:any=(req:any,res:any,next:any)=>req.authUser.accountType==='tenant'?next():res.sendStatus(403)
  const organizationById=async(id:string)=>({id,name:id,status:id==='suspended'?'Suspended':'Active'})
  registerIntegrationRoutes(app,{db,requireAuth:auth,requireTenant:tenant,organizationById,store,reconnect:async()=>{},status:()=>({online:false})})
  registerPlatformSettings(app,{db,requireAuth:auth,requirePlatformAdmin,organizationById})
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${(server.address() as any).port}`
  const call=(url:string,user?:string,method='GET',body?:any,id='a')=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...(user?{'x-test-user':user}:{}),'x-test-tenant':id},body:body?JSON.stringify(body):undefined})
  try {
    assert.equal((await call('/api/account/integrations')).status,401)
    for (const role of ['viewer','no-settings','platform']) assert.equal((await call('/api/account/integrations',role)).status,403)
    assert.equal((await call('/api/account/integrations','admin','GET',undefined,'suspended')).status,403)
    assert.equal((await call('/api/account/integrations/openai','admin','PUT',{secret:secretA,tenant_id:'b',organizationId:'b'})).status,200)
    assert.equal(await store.row('b','openai'),null)
    assert.equal((await store.active('a','openai'))?.secret,secretA)
    const payload=await (await call('/api/account/integrations','admin')).text()
    assert(!payload.includes(secretA));assert(!payload.includes('encrypted_secret'))
    assert.equal((await call('/api/internal-admin/system','admin')).status,403)
    assert.equal((await call('/api/internal-admin/organizations/b/task-settings','admin','PUT',{})).status,403)
    const health=await call('/api/internal-admin/system','platform')
    assert.equal(health.status,200);assert(!(await health.text()).includes('encrypted_secret'))
    assert.equal((await call('/api/account/templates','admin','PUT',{name:'template.xlsx',content_base64:new PizZip().file('[Content_Types].xml','<Types/>').file('xl/workbook.xml','<workbook/>').generate({type:'base64'})})).status,200)
    const other=await (await call('/api/account/templates','admin','GET',undefined,'b')).json();assert.equal(other.template,null)
  } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())) }
})
