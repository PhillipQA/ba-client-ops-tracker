import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerFsdRoutes } from '../server/documents/fsd-documents'
import { groundingFromSourceAnalyses, sourceAnalysisFingerprint, validateSourceAnalysis } from '../server/documents/fsd-source-analysis'
import { emptyFsdDraft, fsdSectionsForModules, type FsdSource, type FsdSourceAnalysis } from '../src/fsd-model'

const source: FsdSource = { id:'SRC-001',name:'BRD.txt',kind:'BRD',target:'',text:'MMS Report lists stock. The report shows amounts in PHP.' }
const modules = ['MMS Report'] as const
const reading = (s=source) => ({readability:'readable',summary:'The stock report lists stock.',complete:true,requirements:[{id:'R1',module:'MMS Report',requirement:s.text,evidence:[{sourceId:s.id,quote:s.text}]}],gaps:[]})
function analyzed(s=source): FsdSourceAnalysis {return {...validateSourceAnalysis(reading(s),s,[...modules]),fingerprint:sourceAnalysisFingerprint(s,modules),provider:'Fixture',model:'Fixture',analyzedAt:new Date().toISOString()}}

test('source edits and scope changes invalidate reuse; identical source reviews retain their evidence',()=>{
  const cached={...source,analysis:analyzed()}
  assert.equal(groundingFromSourceAnalyses([source],[cached],[...modules]).requirements[0].evidence[0].quote,source.text)
  assert.throws(()=>groundingFromSourceAnalyses([{...source,text:'Changed requirements'}],[cached],[...modules]),/source or scope changed/)
  assert.throws(()=>groundingFromSourceAnalyses([source],[cached],[]),/source or scope changed/)
  assert.throws(()=>groundingFromSourceAnalyses([{...source,target:'report'}],[cached],[...modules]),/source or scope changed/)
})

test('reading warnings remain visible and incomplete or unreadable content cannot enter FSD generation',()=>{
  const withWarning={...source,text:'[Extraction warning: image layout needs review.]\n'+source.text}
  assert.equal(validateSourceAnalysis(reading(withWarning),withWarning,[...modules]).readability,'partial')
  const a=analyzed()
  assert.throws(()=>groundingFromSourceAnalyses([source],[{...source,analysis:{...a,complete:false}}],[...modules]),/review is incomplete/)
  assert.throws(()=>groundingFromSourceAnalyses([source],[{...source,analysis:{...a,readability:'unreadable',requirements:[]}}],[...modules]),/no usable content/)
  assert.throws(()=>validateSourceAnalysis({...reading(),requirements:[{...reading().requirements[0],evidence:[{sourceId:source.id,quote:'Invented monthly limit'}]}]},source,[...modules]),/excerpt not found/)
})

test('upload review works before details or presets; generation uses all reviewed sources and the latest preset', async()=>{
  const originalFetch=globalThis.fetch
  const wire:any[]=[]
  let reply:any=reading()
  globalThis.fetch=(async(input:any,options:any)=>{
    if (!String(input).startsWith('https://api.anthropic.com/')) return originalFetch(input,options)
    wire.push(JSON.parse(options.body))
    return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(reply)}]}),{headers:{'content-type':'application/json'}})
  }) as typeof fetch
  const app=express();app.use(express.json())
  app.use((req:any,_res,next)=>{req.authUser={organizationId:'fixture',role:'Administrator',modules:['documents']};next()})
  const pass=(_r:any,_s:any,next:any)=>next()
  const db:any={from:()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:null,error:null}}})}
  const aiAgents:any={active:async()=>({secret:'synthetic-fixture-key',config:{provider:'anthropic',model:'fixture-model'}})}
  registerFsdRoutes(app,{db,requireAuth:pass,requireTenant:pass,aiAgents,logoPath:new URL('../templates/fsd-logo.png',import.meta.url).pathname})
  const server=app.listen(0);const base=`http://127.0.0.1:${(server.address() as any).port}`
  const post=async(path:string,body:unknown)=>{const r=await originalFetch(base+'/api/documents/fsd/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
  try {
    const first=await post('analyze-source',{source,modules})
    assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(wire.length,1)
    assert.equal(JSON.parse(wire[0].messages[0].content).source.text,source.text)
    const secondSource:FsdSource={...source,id:'SRC-002',name:'Meeting notes.txt',kind:'Meeting notes',text:'The report shows amounts in USD.'}
    reply=reading(secondSource)
    const second=await post('analyze-source',{source:secondSource,modules})
    assert.equal(second.status,200,JSON.stringify(second.body))
    const draft={...emptyFsdDraft(),modules:[...modules],sourceReviewVersion:1,sources:[{...source,analysis:first.body},{...secondSource,analysis:second.body}],presetInstructions:'QA preset: emphasize currency acceptance criteria.'}
    Object.assign(draft.details,{client:'Fixture',feature:'Stock report',author:'Tester'})
    reply={sections:fsdSectionsForModules(draft.modules).map(([id,title])=>({id,title,sourceIds:[],blocks:id==='acceptance'?[{type:'table',headers:['AC ID','Scenario','Expected result'],rows:[['AC-1','View stock','Stock appears; currency TBD']],requirementIds:['REQ-001','REQ-002']}]:[{type:'paragraph',text:id==='report'?'TBD — currency requires confirmation':'Stock report currency requires confirmation.',requirementIds:['REQ-001','REQ-002']}]})),gaps:[],conflicts:['BRD.txt specifies PHP; Meeting notes.txt specifies USD. Confirm the intended currency.']}
    const before=wire.length
    const combined=await post('preview',draft)
    assert.equal(combined.status,200,JSON.stringify(combined.body));assert.equal(wire.length,before+1,'cached source reviews must not trigger another reading call')
    const writing=JSON.parse(wire.at(-1).messages[0].content)
    assert.equal(writing.preset,draft.presetInstructions);assert.equal(writing.requirements.length,2)
    assert.deepEqual(writing.sourceCatalog.map((s:any)=>s.name),['BRD.txt','Meeting notes.txt'])
    assert.ok(writing.requirements.some((r:any)=>r.evidence.some((e:any)=>e.quote.includes('USD'))))
    assert.ok(writing.requirements.some((r:any)=>r.evidence.some((e:any)=>e.quote.includes('PHP'))))
    assert.equal(writing.sources,undefined);assert.match(combined.body.conflicts[0],/PHP.*USD/)
    const exported=await post('generate',{...draft,preview:combined.body,reviewed:true})
    assert.equal(exported.status,200,JSON.stringify(exported.body));assert.ok(exported.body.fileData)
    const changed=await post('preview',{...draft,sources:[{...draft.sources[0],text:'Edited source'},draft.sources[1]]})
    assert.equal(changed.status,422);assert.match(changed.body.error,/source or scope changed/);assert.equal(wire.length,before+1)
    const excluded=await post('analyze-source',{source:{...source,target:'pos'},modules})
    assert.equal(excluded.status,400);assert.equal(wire.length,before+1)
    const unreadable=await post('analyze-source',{source:{...source,text:'[Extraction warning: no readable text found in this image; inspect the original for visual requirements.]'},modules})
    assert.equal(unreadable.status,200);assert.equal(unreadable.body.readability,'unreadable');assert.equal(wire.length,before+1)
  } finally {globalThis.fetch=originalFetch;await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
