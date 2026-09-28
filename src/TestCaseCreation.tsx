import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ClipboardCheck, Copy, Download, FileSearch, FileText, Plus, Sparkles, Trash2 } from 'lucide-react'
import { readFsdSource } from './fsd-sources'
import DocumentProcessingPanel from './DocumentProcessingPanel'
import DocumentReset from './DocumentReset'
import { useDocumentOperation } from './useDocumentOperation'
import { reviewCoverage, TEST_CASE_COLUMNS, TEST_CASE_SKILLS, type CoverageMap, type TestCasePreview, type TestCaseRow, type TestCaseSkill, type TestCaseSource, type TestCaseSourceKind } from './testcase-model'
import './testcase.css'

type Provider = { enabled: boolean; provider?: string; name?: string; model?: string }
type Draft = {
  suiteName: string
  sources: TestCaseSource[]
  sourceKind: TestCaseSourceKind
  pasteName: string
  pasteText: string
  pasteKind: TestCaseSourceKind
  selectedSkillIds: string[]
  customSkills: TestCaseSkill[]
  customSkillName: string
  customSkillInstructions: string
  coverage: CoverageMap | null
  preview: TestCasePreview | null
  inputRevision: number
  coverageRevision: number
  previewRevision: number
}
const SOURCE_KINDS: TestCaseSourceKind[] = ['BRD','FSD','User Story','Acceptance Criteria','Change Request','Meeting notes','Supporting document','Chat']
const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff'
function freshDraft(): Draft { return { suiteName:'Test Case Suite',sources:[],sourceKind:'BRD',pasteName:'',pasteText:'',pasteKind:'Chat',selectedSkillIds:['functional','negative-edge'],customSkills:[],customSkillName:'',customSkillInstructions:'',coverage:null,preview:null,inputRevision:0,coverageRevision:-1,previewRevision:-1 } }
function sourceId(sources: TestCaseSource[]) { return `SRC-${String(Math.max(0,...sources.map(s=>Number(s.id.replace(/^SRC-/,''))||0))+1).padStart(3,'0')}` }
function tcId(rows: TestCaseRow[]) { return `TC-${String(Math.max(0,...rows.map(r=>Number(r.id.replace(/^TC-/,''))||0))+1).padStart(3,'0')}` }
async function request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch(`/api/documents/test-cases/${path}`,{signal,method:body?'POST':'GET',credentials:'same-origin',headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  const payload=await response.json().catch(()=>({})) as {error?:string}&T
  if(!response.ok) throw new Error(payload.error||'Test Case Creator request failed.')
  return payload
}
const readSource = readFsdSource
function downloadBase64(base64:string,mimeType:string,fileName:string){const binary=atob(base64),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const url=URL.createObjectURL(new Blob([bytes],{type:mimeType})),a=document.createElement('a');a.href=url;a.download=fileName;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}

export default function TestCaseCreation({canGenerate,draftKey,active}:{canGenerate:boolean;draftKey:string;active:boolean}){
  const storageKey=`ba-testcase-v1:${draftKey}`,skillsKey=`ba-testcase-skills-v1:${draftKey}`
  const [draft,setDraft]=useState<Draft>(()=>{const base=freshDraft();try{const skills=JSON.parse(localStorage.getItem(skillsKey)||'[]');if(Array.isArray(skills))base.customSkills=skills.filter(v=>v&&typeof v.id==='string'&&typeof v.name==='string'&&typeof v.instructions==='string').slice(0,30)}catch{}try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved&&Array.isArray(saved.sources))return{...base,...saved,customSkills:base.customSkills}}catch{}return base})
  const [provider,setProvider]=useState<Provider|null>(null),[providerError,setProviderError]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[saveError,setSaveError]=useState(''),[showSources,setShowSources]=useState(false)
  const operation=useDocumentOperation(),draftRef=useRef(draft),fileInput=useRef<HTMLInputElement>(null);draftRef.current=draft
  useEffect(()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(draft));setSaveError('')}catch{setSaveError('Draft recovery could not be saved. Keep this page open until you finish.')}},[draft,storageKey])
  useEffect(()=>{try{localStorage.setItem(skillsKey,JSON.stringify(draft.customSkills))}catch{}},[draft.customSkills,skillsKey])
  useEffect(()=>{if(!active)return;let alive=true;request<Provider>('provider').then(v=>{if(alive){setProvider(v);setProviderError('')}}).catch(e=>{if(alive){setProvider(null);setProviderError(e.message)}});return()=>{alive=false}},[active])
  const skills=useMemo(()=>[...TEST_CASE_SKILLS,...draft.customSkills],[draft.customSkills])
  const selectedSkills=skills.filter(s=>draft.selectedSkillIds.includes(s.id))
  const coverageStale=Boolean(draft.coverage)&&(draft.coverageRevision!==draft.inputRevision||draft.coverage!.requirements.some(r=>!r.evidence?.length))
  const coverageReview=reviewCoverage(draft.preview?.cases||[],draft.coverage)
  const previewStale=Boolean(draft.preview)&&(coverageStale||draft.previewRevision!==draft.coverageRevision)
  const patch=(values:Partial<Draft>,inputChange=false)=>setDraft(d=>({...d,...values,inputRevision:inputChange?d.inputRevision+1:d.inputRevision}))
  const touchCoverage=(coverage:CoverageMap)=>setDraft(d=>({...d,coverage,preview:null,coverageRevision:d.inputRevision,previewRevision:-1}))
  async function addFiles(files:File[]){if(!files.length||busy)return;if(draft.sources.length+files.length>20){setError('Use up to 20 sources.');return}const job=operation.begin();setBusy('Reading requirement sources…');setError('');const added:TestCaseSource[]=[],errors:string[]=[];for(const file of files){if(!job.isCurrent())return;try{const text=await readSource(file,message=>{if(job.isCurrent())setBusy(message)});if(!job.isCurrent())return;added.push({id:sourceId([...draftRef.current.sources,...added]),name:file.name,kind:draftRef.current.sourceKind,text})}catch(e){errors.push(e instanceof Error?e.message:'Could not read source.')}}if(!job.isCurrent())return;setDraft(d=>({...d,sources:[...d.sources,...added],inputRevision:d.inputRevision+1}));setError(errors.join('\n'));setBusy('')}
  function addPaste(){if(!draft.pasteText.trim())return;if(draft.sources.length>=20||draft.pasteText.length>120000){setError('Use up to 20 sources, each up to 120,000 characters.');return}patch({sources:[...draft.sources,{id:sourceId(draft.sources),name:draft.pasteName.trim()||`${draft.pasteKind} ${draft.sources.length+1}`,kind:draft.pasteKind,text:draft.pasteText.trim()}],pasteName:'',pasteText:''},true)}
  function toggleSkill(id:string){const has=draft.selectedSkillIds.includes(id),next=has?draft.selectedSkillIds.filter(v=>v!==id):[...draft.selectedSkillIds,id];if(!next.length){setError('Keep at least one testing skill selected.');return}setError('');patch({selectedSkillIds:next},true)}
  function saveSkill(){const name=draft.customSkillName.trim(),instructions=draft.customSkillInstructions.trim();if(!name||!instructions){setError('Enter a custom skill name and instructions.');return}const id=`custom-${crypto.randomUUID()}`,skill={id,name:name.slice(0,120),instructions:instructions.slice(0,8000)};setDraft(d=>({...d,customSkills:[...d.customSkills,skill],selectedSkillIds:[...d.selectedSkillIds,id],customSkillName:'',customSkillInstructions:'',inputRevision:d.inputRevision+1}));setError('')}
  async function buildCoverage(){if(busy)return;if(draft.pasteText.trim()){setError('Add pasted text to Sources first.');return}if(!draft.sources.length||!selectedSkills.length){setError('Add at least one requirement source and select a testing skill.');return}const job=operation.begin();setBusy('AI is mapping requirements and test coverage…');setError('');try{const coverage=await request<CoverageMap>('coverage',{sources:draft.sources,skills:selectedSkills},job.signal);if(!job.isCurrent())return;touchCoverage(coverage);setProvider(p=>({...p,enabled:true,name:coverage.provider,model:coverage.model}))}catch(e){if(job.isCurrent())setError(e instanceof Error?e.message:'Coverage mapping failed.')}finally{if(job.isCurrent())setBusy('')}}
  async function generateCases(){if(!draft.coverage||coverageStale||busy)return;const job=operation.begin();setBusy('AI is generating traceable test cases…');setError('');try{const preview=await request<TestCasePreview>('generate',{sources:draft.sources,skills:selectedSkills,coverage:draft.coverage},job.signal);if(!job.isCurrent())return;setDraft(d=>({...d,preview,previewRevision:d.coverageRevision}));setProvider(p=>({...p,enabled:true,name:preview.provider,model:preview.model}))}catch(e){if(job.isCurrent())setError(e instanceof Error?e.message:'Test case generation failed.')}finally{if(job.isCurrent())setBusy('')}}
  function updateCoverage(index:number,key:'title'|'scenarios',value:string){if(!draft.coverage)return;const coverage=structuredClone(draft.coverage);if(key==='title')coverage.requirements[index].title=value;else coverage.requirements[index].scenarios=value.split('\n').map(v=>v.trim()).filter(Boolean);setDraft(d=>({...d,coverage,preview:null,previewRevision:-1}))}
  function updateCase(index:number,key:keyof TestCaseRow,value:string){if(!draft.preview)return;const preview=structuredClone(draft.preview);(preview.cases[index] as any)[key]=value;setDraft(d=>({...d,preview}))}
  function removeCase(index:number){if(!draft.preview)return;const preview=structuredClone(draft.preview);preview.cases.splice(index,1);setDraft(d=>({...d,preview}))}
  function duplicateCase(index:number){if(!draft.preview)return;const preview=structuredClone(draft.preview),row=structuredClone(preview.cases[index]);row.id=tcId(preview.cases);preview.cases.splice(index+1,0,row);setDraft(d=>({...d,preview}))}
  function addCase(){if(!draft.preview)return;const preview=structuredClone(draft.preview);preview.cases.push({id:tcId(preview.cases),module:'General',requirementRef:draft.coverage?.requirements[0]?.id||'REQ-001',scenario:'',preconditions:'None specified',steps:'1. ',expectedResult:'',priority:'Medium',type:'Functional',testData:'As required',platform:'As specified',automationCandidate:'Review',remarks:''});setDraft(d=>({...d,preview}))}
  async function exportCases(){if(!draft.preview||busy||previewStale)return;const job=operation.begin();setBusy('Preparing Excel test case suite…');setError('');try{const result=await request<{fileData:string;fileName:string;mimeType:string}>('export',{suiteName:draft.suiteName,cases:draft.preview.cases,coverage:draft.coverage,sources:draft.sources},job.signal);if(!job.isCurrent())return;downloadBase64(result.fileData,result.mimeType,result.fileName)}catch(e){if(job.isCurrent())setError(e instanceof Error?e.message:'Excel export failed.')}finally{if(job.isCurrent())setBusy('')}}
  function reset(){
    operation.cancel()
    const next=freshDraft();next.customSkills=draftRef.current.customSkills;draftRef.current=next
    try{sessionStorage.removeItem(storageKey)}catch{ /* The save effect reports storage failures. */ }
    if(fileInput.current)fileInput.current.value=''
    setDraft(next);setError('');setBusy('');setSaveError('');setShowSources(false)
  }
  return <div className="tc-creator">
    <div className="tc-topline"><div><span className="tc-eyebrow">DOCUMENT CREATION</span><h2>Test Case Creator</h2><p>Turn requirements into traceable, editable QA and UAT test cases with AI-assisted coverage review.</p></div><span className="tc-badge"><ClipboardCheck size={17}/>AI + Skills + XLSX</span></div>
    <DocumentReset label="test cases" onReset={reset} disabled={!canGenerate} />
    <div className="tc-status"><span>{provider?.enabled?`Document Agent: ${provider.name} · ${provider.model}`:providerError||'Configure and enable the Document Agent in Account Settings.'}</span><span>{saveError||'Draft retained in this browser tab'}</span></div>
    {draft.sources.some(s=>s.text.includes('[Extraction warning:'))&&<p className="tc-warning">Some sources contain OCR or visual content. Review source text and original diagrams before mapping coverage.</p>}
    <DocumentProcessingPanel state={error?'error':busy?'working':draft.preview?'success':'idle'} title={error?'Test Case processing failed':busy||'Test cases are ready'} detail={error||(!busy&&draft.preview?'Review the editable cases below, then download the Excel file.':'')} stages={busy.includes('Reading')?['Uploading documents','Reading and extracting content','Adding sources','Ready for coverage mapping']:busy.includes('Excel')?['Validating test cases','Mapping rows to workbook','Generating Excel file','Starting download']:['Preparing requirements','Mapping test coverage','Generating test cases','Ready for review']} activeStage={busy.includes('Reading')?1:busy.includes('Excel')?2:2}/>
    <fieldset disabled={!canGenerate||Boolean(busy)}>
      <div className="tc-grid">
        <section className="tc-card"><div className="tc-step"><span>1</span><div><h3>Requirement sources</h3><p>Upload BRD, FSD, stories, meeting notes, screenshots, or supporting files. You can combine up to 20 sources.</p></div></div>
          <label>Suite name<input maxLength={120} value={draft.suiteName} onChange={e=>patch({suiteName:e.target.value})}/></label>
          <div className="tc-source-toolbar"><label>Source type<select value={draft.sourceKind} onChange={e=>patch({sourceKind:e.target.value as TestCaseSourceKind})}>{SOURCE_KINDS.map(k=><option key={k}>{k}</option>)}</select></label><label className="tc-upload"><input ref={fileInput} type="file" accept={ACCEPT} multiple onChange={e=>{void addFiles(Array.from(e.target.files||[]));e.target.value=''}}/><Plus size={18}/>Add files</label></div>
          <button type="button" className="secondary tc-wide" onClick={()=>setShowSources(v=>!v)} disabled={!draft.sources.length}><FileSearch size={16}/>{draft.sources.length?`${draft.sources.length} source${draft.sources.length===1?'':'s'} added`:'No sources yet'} · {showSources?'Hide':'Review'}</button>
          {showSources&&<div className="tc-source-list">{draft.sources.map((s,i)=><details key={s.id}><summary><FileText size={15}/><b>{s.id}</b><span>{s.name}</span><small>{s.kind}</small><button type="button" className="tc-icon-danger" aria-label={`Remove ${s.name}`} onClick={e=>{e.preventDefault();e.stopPropagation();patch({sources:draft.sources.filter((_,x)=>x!==i),coverage:null,preview:null,coverageRevision:-1,previewRevision:-1},true)}}><Trash2 size={15}/></button></summary><pre>{s.text.slice(0,5000)}{s.text.length>5000?'\n\n[Preview truncated]':''}</pre></details>)}</div>}
          <details className="tc-paste"><summary>Paste requirement or chat text</summary><div className="tc-two"><label>Type<select value={draft.pasteKind} onChange={e=>patch({pasteKind:e.target.value as TestCaseSourceKind})}>{SOURCE_KINDS.map(k=><option key={k}>{k}</option>)}</select></label><label>Source name<input value={draft.pasteName} maxLength={200} placeholder="e.g. Client Slack clarification" onChange={e=>patch({pasteName:e.target.value})}/></label></div><label>Text<textarea rows={7} maxLength={120000} value={draft.pasteText} onChange={e=>patch({pasteText:e.target.value})}/></label><button type="button" className="secondary" onClick={addPaste}><Plus size={15}/>Add to Sources</button></details>
        </section>
        <section className="tc-card"><div className="tc-step"><span>2</span><div><h3>Testing skills</h3><p>Select one or more reusable skills. Skills change testing emphasis but never override the source requirements.</p></div></div>
          <div className="tc-skills">{skills.map(skill=><label key={skill.id} className={draft.selectedSkillIds.includes(skill.id)?'selected':''}><input type="checkbox" checked={draft.selectedSkillIds.includes(skill.id)} onChange={()=>toggleSkill(skill.id)}/><span><strong>{skill.name}</strong><small>{skill.instructions}</small></span>{!skill.builtIn&&<button type="button" className="tc-skill-delete" onClick={e=>{e.preventDefault();setDraft(d=>({...d,customSkills:d.customSkills.filter(v=>v.id!==skill.id),selectedSkillIds:d.selectedSkillIds.filter(v=>v!==skill.id),inputRevision:d.inputRevision+1}))}}><Trash2 size={13}/></button>}</label>)}</div>
          <details><summary>Create custom skill</summary><label>Skill name<input value={draft.customSkillName} maxLength={120} placeholder="e.g. Velvet Admin QA" onChange={e=>patch({customSkillName:e.target.value})}/></label><label>Instructions<textarea rows={5} maxLength={8000} placeholder="What should AI emphasize when creating cases?" value={draft.customSkillInstructions} onChange={e=>patch({customSkillInstructions:e.target.value})}/></label><button type="button" className="secondary" onClick={saveSkill}><Plus size={15}/>Save & select skill</button></details>
        </section>
      </div>
      <section className="tc-card tc-stage"><div className="tc-step"><span>3</span><div><h3>AI Test Coverage Map</h3><p>Map requirements to scenarios first. Review this before asking AI to write detailed cases.</p></div></div><button type="button" className="primary" disabled={!draft.sources.length||!selectedSkills.length||!provider?.enabled} onClick={()=>void buildCoverage()}><Sparkles size={16}/>{draft.coverage?'Regenerate coverage map':'Generate coverage map'}</button>{!provider?.enabled&&<small className="tc-inline-note">An enabled Document Agent is required.</small>}
        {coverageStale&&<p className="tc-warning">Sources or skills changed, or this older map needs source excerpts. Regenerate it before generating test cases.</p>}
        {draft.coverage&&<><div className="tc-coverage-meta"><span>{draft.coverage.requirements.length} mapped requirements</span><span>{draft.coverage.gaps.length} clarification item{draft.coverage.gaps.length===1?'':'s'}</span><span>{draft.coverage.provider} · {draft.coverage.model}</span></div><div className="tc-coverage-list">{draft.coverage.requirements.map((r,i)=><article key={r.id}><header><b>{r.id}</b><span>{r.sourceIds.join(', ')}</span></header>{r.evidence?.map((e,ei)=><blockquote key={ei}><small>{e.sourceId}</small><p>{e.quote}</p></blockquote>)}<input aria-label={`${r.id} title`} value={r.title} onChange={e=>updateCoverage(i,'title',e.target.value)}/><label>Planned scenarios<textarea rows={Math.min(8,Math.max(3,r.scenarios.length+1))} value={r.scenarios.join('\n')} onChange={e=>updateCoverage(i,'scenarios',e.target.value)}/></label></article>)}</div>{draft.coverage.gaps.length>0&&<div className="tc-gaps"><h4><AlertTriangle size={16}/>Clarification needed</h4><ul>{draft.coverage.gaps.map((g,i)=><li key={i}>{g}</li>)}</ul></div>}</>}
      </section>
      <section className="tc-card tc-stage"><div className="tc-step"><span>4</span><div><h3>Generate & review test cases</h3><p>AI creates traceable cases from the reviewed coverage map. Every row remains editable before export.</p></div></div><button type="button" className="primary" disabled={!draft.coverage||coverageStale} onClick={()=>void generateCases()}><Sparkles size={16}/>{draft.preview?'Regenerate test cases':'Generate test cases'}</button>
        {previewStale&&<p className="tc-warning">Coverage changed after these test cases were generated. Regenerate the test cases.</p>}
      </section>
    </fieldset>
    {draft.preview&&<section className="tc-preview"><div className="tc-preview-head"><div><h3>Editable Test Case Preview</h3><small>{draft.preview.cases.length} cases · {draft.preview.provider} · {draft.preview.model} · {new Date(draft.preview.generatedAt).toLocaleString()}</small></div><button className="secondary" onClick={addCase} disabled={!canGenerate||Boolean(busy)}><Plus size={15}/>Add test case</button></div>
      <div className="tc-table-scroll"><table><thead><tr>{TEST_CASE_COLUMNS.map(c=><th key={c.key}>{c.label}</th>)}<th>Actions</th></tr></thead><tbody>{draft.preview.cases.map((row,ri)=><tr key={`${row.id}-${ri}`}>{TEST_CASE_COLUMNS.map(c=><td key={c.key}>{c.key==='priority'?<select value={row.priority} onChange={e=>updateCase(ri,c.key,e.target.value)}>{['Low','Medium','High','Critical'].map(v=><option key={v}>{v}</option>)}</select>:c.key==='automationCandidate'?<select value={row.automationCandidate} onChange={e=>updateCase(ri,c.key,e.target.value)}>{['Yes','No','Review'].map(v=><option key={v}>{v}</option>)}</select>:<textarea aria-label={`${row.id} ${c.label}`} rows={c.key==='steps'||c.key==='expectedResult'?5:3} value={String(row[c.key]??'')} onChange={e=>updateCase(ri,c.key,e.target.value)}/>}</td>)}<td className="tc-row-actions"><button type="button" title="Duplicate" onClick={()=>duplicateCase(ri)}><Copy size={15}/></button><button type="button" title="Delete" onClick={()=>removeCase(ri)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>
      <div className="tc-review"><div><h3>Requirement Link Review</h3><p>{coverageReview.summary}</p></div><div className="tc-score"><strong>{coverageReview.coveredRequirements}/{coverageReview.totalRequirements}</strong><span>requirements linked</span></div>{coverageReview.findings.length>0&&<ul>{coverageReview.findings.map((f,i)=><li key={i} className={f.severity}><AlertTriangle size={14}/>{f.text}</li>)}</ul>}</div>
      <div className="tc-export"><span>Export preserves your edited preview as an Excel test case suite.</span><button type="button" className="primary" disabled={Boolean(busy)||!canGenerate||!draft.preview.cases.length||previewStale} onClick={()=>void exportCases()}><Download size={16}/>Download XLSX</button></div>
    </section>}
    <div className="tc-footer"><small>Draft sources, skills, coverage and edits stay in this browser tab until reset. Saved custom skills remain available for future suites.</small></div>
  </div>
}
