import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import PizZip from 'pizzip'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import FsdFeatureFields from '../src/FsdFeatureFields'
import { emptyFsdDraft, fsdSectionsForModules, type FsdFeature, type FsdSource, type FsdSourceAnalysis } from '../src/fsd-model'
import { fsdFeatureCode, migrateFsdFeatures, nextFsdFeatureId } from '../src/fsd-features'
import { fsdReadiness } from '../src/fsd-readiness'
import { validateFsdScope } from '../server/documents/fsd-scope'
import { groundingFromSourceAnalyses, sourceAnalysisFingerprint, validateSourceAnalysis, validateSourceAnalysisInput } from '../server/documents/fsd-source-analysis'
import { assertFsdGrounding, interpretRequirements } from '../server/documents/fsd-grounding'
import { normalizeFeaturePreview, FSD_PROCESS_LABELS } from '../server/documents/fsd-feature-preview'
import { registerFsdRoutes } from '../server/documents/fsd-documents'

const features: FsdFeature[] = [{ id: 'feature-001', name: 'Metabase Report' }, { id: 'feature-002', name: 'Sales Transfer' }]
const modules = features.map(f => f.id)
const source: FsdSource = { id: 'SRC-001', name: 'Metabase notes.txt', kind: 'Chat', target: 'feature-001', text: 'Metabase report shows item codes.' }
const reading = (s=source) => ({ readability: 'readable', complete: true, summary: s.text, requirements: [{ id:'R1', module: s.target || 'General', requirement: s.text, evidence: [{ sourceId: s.id, quote: s.text }] }], gaps: [] })
function analyzed(s = source): FsdSource {
  const analysis: FsdSourceAnalysis = { ...validateSourceAnalysis(reading(s),s,modules), fingerprint: sourceAnalysisFingerprint(s,modules,features), provider: 'Fixture', model: 'Fixture', analyzedAt: '2026-10-07T00:00:00Z' }
  return { ...s, analysis }
}
function draft() {
  const d=emptyFsdDraft();Object.assign(d.details,{client:'Acme',feature:'Reporting and Transfers',author:'QA'})
  return {...d,features,modules,sources:[analyzed()],sourceReviewVersion:1,allowIncomplete:true}
}

test('custom names become ordered feature headings without legacy module headings',()=>{
  const sections=fsdSectionsForModules(modules,features)
  assert.deepEqual(sections.filter(([id])=>id.startsWith('feature-')), [['feature-001','5.1 Metabase Report'],['feature-002','5.2 Sales Transfer']])
  assert.ok(!sections.some(([id])=>['mms','report','pos','lynexus'].includes(id)))
  assert.ok(sections.some(([id])=>id==='acceptance'))
  const ui=renderToStaticMarkup(createElement(FsdFeatureFields,{features,client:'Acme',reservedIds:[],onChange:()=>{}}))
  assert.match(ui,/Feature Name 1/);assert.match(ui,/Feature Name 2/);assert.match(ui,/Add feature/)
  assert.ok(!ui.includes('type="checkbox"'));assert.match(ui,/Metabase Report/)
})

test('custom feature validation rejects blank, duplicate or invalid feature configuration',()=>{
  assert.deepEqual(validateFsdScope({features}).modules,modules)
  assert.throws(()=>validateFsdScope({features:[]}),/Add 1 to 20/)
  assert.throws(()=>validateFsdScope({features:[{id:'feature-001',name:' '}]}),/Enter Feature Name/)
  assert.doesNotThrow(()=>validateFsdScope({features:[{id:'feature-001',name:''}]},true),'upload review may precede naming')
  assert.throws(()=>validateFsdScope({features:[features[0],{id:'feature-002',name:'metabase report'}]}),/unique name/)
  assert.throws(()=>validateFsdScope({features:[{id:'pos',name:'Custom feature'}]}),/Invalid feature/)
})

test('legacy drafts preserve uploads and text but invalidate previews and remap active legacy targets',()=>{
  const d=emptyFsdDraft();d.details.feature='Metabase Report';d.modules=['MMS Report']
  d.sources=[{...source,target:'report'},{...source,id:'SRC-002',target:'pos'}];d.mapping={report:'Show report filters'};d.preview={} as any
  const migrated=migrateFsdFeatures(d)
  assert.equal(migrated.sources[0].text,source.text);assert.equal(migrated.sources[0].target,'feature-001')
  assert.equal(migrated.sources[1].target,'pos','previously excluded sources stay excluded until remapped')
  assert.equal(migrated.preview,null);assert.equal(migrated.sources[0].analysis,undefined)
  assert.equal(migrated.mapping['feature-001'],'Show report filters');assert.equal(migrated.features![0].name,'Metabase Report')
  assert.deepEqual(migrateFsdFeatures(migrated),migrated)
  assert.equal(nextFsdFeatureId(features,['feature-003']),'feature-004','removed feature IDs must not be reused while mapped sources still exist')
})

test('feature renaming and reordering invalidate cached source review while explicit mappings stay enforced',()=>{
  const a=analyzed()
  assert.equal(groundingFromSourceAnalyses([source],[a],modules,true,features).requirements[0].module,'feature-001')
  assert.throws(()=>groundingFromSourceAnalyses([source],[a],modules,true,[{...features[0],name:'Renamed'},features[1]]),/source or scope changed/)
  assert.throws(()=>groundingFromSourceAnalyses([source],[a],modules,true,[features[1],features[0]]),/source or scope changed/)
  assert.throws(()=>interpretRequirements({...reading(),requirements:[{...reading().requirements[0],module:'feature-002'}]},[source],modules),/explicit module mapping/)
  assert.throws(()=>validateSourceAnalysisInput({source:{...source,target:'feature-099'},features}),/removed feature/)
})

test('missing information names the custom feature and removed feature sources are excluded',()=>{
  const issues=fsdReadiness([analyzed()],modules,features)
  assert.ok(issues.some(i=>i.title==='Sales Transfer' && /feature-specific/.test(i.missing)))
  assert.ok(!issues.some(i=>i.title==='POS Feature'))
  assert.match(fsdReadiness([{...source,target:'feature-099'}],modules,features)[0].missing,/mapped only/)
})

test('process table row structure and generic hierarchical codes survive sparse custom previews',()=>{
  const raw={sections:features.map(f=>({id:f.id,title:'Wrong legacy name',sourceIds:[],blocks:[{type:'paragraph',text:'TBD — Pending information',requirementIds:[]}]})),gaps:[],conflicts:[]}
  const preview=normalizeFeaturePreview(raw,features,'Acme')
  for(const [i,section] of preview.sections.entries()) {
    const table=section.blocks.find((b:any)=>b.type==='table'&&b.headers.length===2)
    assert.deepEqual(table.rows.map((r:string[])=>r[0]),FSD_PROCESS_LABELS)
    assert.equal(table.rows[0][1],`${fsdFeatureCode('Acme',i)} - ${features[i].name}`)
    assert.match(table.rows[1][1],new RegExp(`${fsdFeatureCode('Acme',i)}-01`))
    assert.match(table.rows[2][1],new RegExp(`${fsdFeatureCode('Acme',i)}-01-01`))
    assert.equal(table.rows[6][1],'TBD — Pending information')
  }
  assert.doesNotThrow(()=>assertFsdGrounding(preview,[],modules,true,features))
  assert.equal(raw.sections[0].blocks.length,1,'formatting must not mutate the original draft')
  assert.deepEqual(normalizeFeaturePreview(preview,features,'Acme'),preview,'codes must not accumulate on repeated formatting')
})

async function harness(run:(post:(path:string,body:any)=>Promise<{status:number;body:any}>,setReply:(v:any)=>void,wire:any[])=>Promise<void>) {
  const originalFetch=globalThis.fetch,wire:any[]=[];let reply:any=reading()
  globalThis.fetch=(async(url:any,options:any)=>{if(!String(url).startsWith('https://api.anthropic.com/'))return originalFetch(url,options);wire.push(JSON.parse(options.body));return new Response(JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(reply)}]}),{headers:{'content-type':'application/json'}})}) as typeof fetch
  const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.authUser={organizationId:'fixture',role:'Administrator',modules:['documents']};next()})
  const pass=(_r:any,_s:any,next:any)=>next(),db:any={from:()=>({select(){return this},eq(){return this},async maybeSingle(){return {data:null,error:null}}})},aiAgents:any={active:async()=>({secret:'synthetic-fixture-only',config:{provider:'anthropic',model:'fixture'}})}
  registerFsdRoutes(app,{db,requireAuth:pass,requireTenant:pass,aiAgents,logoPath:new URL('../templates/fsd-logo.png',import.meta.url).pathname})
  const server=app.listen(0),base=`http://127.0.0.1:${(server.address() as any).port}/api/documents/fsd/`
  const post=async(path:string,body:any)=>{const r=await originalFetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}}
  try{await run(post,v=>{reply=v},wire)}finally{globalThis.fetch=originalFetch;await new Promise<void>(resolve=>server.close(()=>resolve()))}
}

test('multiple custom features flow through source review, preview and Word export with retained process tables',async()=>{
  await harness(async(post,setReply,wire)=>{
    const reviewed=await post('analyze-source',{source,features})
    assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));assert.equal(reviewed.body.requirements[0].module,'feature-001')
    assert.match(wire[0].system,/Metabase Report/)
    const d={...draft(),sources:[{...source,analysis:reviewed.body}]}
    setReply({sections:[{id:'feature-001',sourceIds:[],blocks:[{type:'paragraph',text:source.text,requirementIds:['REQ-001']}]}],gaps:[],conflicts:[]})
    const preview=await post('preview',d)
    assert.equal(preview.status,200,JSON.stringify(preview.body));assert.deepEqual(preview.body.features,features)
    assert.equal(preview.body.sections.find((s:any)=>s.id==='feature-001').title,'5.1 Metabase Report')
    assert.equal(preview.body.sections.find((s:any)=>s.id==='feature-002').title,'5.2 Sales Transfer')
    const writing=JSON.parse(wire.at(-1).messages[0].content)
    assert.equal(writing.featureCodes[0].code,'ACME-FEATURE-01');assert.equal(writing.sources,undefined)
    const generated=await post('generate',{...d,preview:preview.body,reviewed:true})
    assert.equal(generated.status,200,JSON.stringify(generated.body))
    const word=new PizZip(Buffer.from(generated.body.fileData,'base64')).file('word/document.xml')!.asText()
    assert.match(word,/5. Software Features/);assert.match(word,/5.1 Metabase Report/);assert.match(word,/5.2 Sales Transfer/)
    for(const label of FSD_PROCESS_LABELS)assert.match(word,new RegExp(label))
    assert.match(word,/ACME-FEATURE-01/);assert.match(word,/ACME-FEATURE-02/)
    assert.ok(!word.includes('5.1 MMS Feature'));assert.ok(!word.includes('5.4 POS Feature'))
    assert.match(word,/Sales Transfer: No feature-specific/)
    const renamed=await post('generate',{...d,features:[{...features[0],name:'New name'},features[1]],preview:preview.body,reviewed:true})
    assert.equal(renamed.status,422);assert.match(renamed.body.error,/Feature names or order changed/)
  })
})

test('normal preview supports named feature tables and rejects cross-feature evidence',async()=>{
  await harness(async(post,setReply)=>{
    const d={...draft(),allowIncomplete:false}
    const blocks=fsdSectionsForModules(modules,features).map(([id,title])=>({id,title,sourceIds:[],blocks:[{type:'paragraph',text:id==='feature-001'?source.text:'TBD — Pending information',requirementIds:id==='feature-001'?['REQ-001']:[]}]}))
    setReply({sections:blocks,gaps:[],conflicts:[]})
    const preview=await post('preview',d);assert.equal(preview.status,200,JSON.stringify(preview.body))
    const result=await post('generate',{...d,preview:preview.body,reviewed:true});assert.equal(result.status,200,JSON.stringify(result.body))
    const wrong=structuredClone(preview.body)
    wrong.sections.find((s:any)=>s.id==='feature-002').blocks.unshift({type:'paragraph',text:source.text,requirementIds:['REQ-001']})
    const rejected=await post('generate',{...d,preview:wrong,reviewed:true});assert.equal(rejected.status,422);assert.match(rejected.body.error,/another module/)
  })
})
