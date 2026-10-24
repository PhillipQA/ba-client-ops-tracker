import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceVersion, mergeActivity } from '../server/services/workspace-version'
import { validateCoverage, validatePreview } from '../server/documents/testcase-documents'
import { reviewCoverage } from '../src/features/documents/testcase-model'
import { assertFsdGrounding, interpretRequirements } from '../server/documents/fsd-grounding'
import { buildAssistantContext, assistantPeriod } from '../server/ai/assistant-context'
import { gmailBodyText, gmailWindowStart, syncGmailPages } from '../server/integrations/gmail-content'
import { businessDateKey, setBusinessTimeZone } from '../src/shared/businessDate'
import { reconcileNotifications } from '../server/services/notification-engine'
import { defaultTaskSettings } from '../src/app/data'
const sources: any[]=[{id:'s',name:'BRD',kind:'BRD',text:'Stock is shown. Supervisor approval is required for refunds.',target:''}]
const req=(id:string,quote:string)=>({id,title:quote,sourceIds:['s'],evidence:[{sourceId:'s',quote}],scenarios:['Check this requirement']})
const coverage={requirements:[req('R1','Stock is shown.'),req('R2','Supervisor approval is required for refunds.')],gaps:[]}
const row:any={id:'T1',module:'Stock',requirementRef:'R1',scenario:'Read stock',steps:'1. View stock',expectedResult:'Stock is shown',preconditions:'None',priority:'Medium',type:'Functional',testData:'Stock',platform:'Browser',automationCandidate:'Review',remarks:''}

test('workspace revisions detect stale edits, inserts and deletions, while dedicated API data is preserved',()=>{
 const state={clients:[],projects:[],items:[{id:'a',priority:'Medium',comments:[],evidence:[]}],planner:[],rtms:[]}
 const initial=workspaceVersion(state)
 assert.notEqual(workspaceVersion({...state,items:[{...state.items[0],priority:'High'}]}),initial)
 assert.notEqual(workspaceVersion({...state,items:[...state.items,{id:'b'}]}),initial)
 assert.notEqual(workspaceVersion({...state,items:[]}),initial)
 assert.equal(workspaceVersion({...state,items:[{...state.items[0],comments:[{id:'c'}],evidence:[{id:'e'}],driveFiles:[{id:'d'}]}],notifications:[{id:'n'}]}),initial)
 assert.deepEqual(mergeActivity([{id:'old',text:'Original'}],[{id:'old',text:'Stale'},{id:'new'}]),[{id:'new'},{id:'old',text:'Original'}])
})
test('coverage rejects duplicate IDs and quotations absent from cited sources',()=>{
 assert.equal(validateCoverage(coverage,sources).requirements.length,2)
 assert.throws(()=>validateCoverage({...coverage,requirements:[coverage.requirements[0],coverage.requirements[0]]},sources),/Duplicate/)
 assert.throws(()=>validateCoverage({requirements:[req('R1','Invented behavior')]},sources),/excerpt/)
})
test('model counts are ignored; edits, deletion and unresolved results recalculate distinct linked coverage',()=>{
 assert.equal(validatePreview({cases:[row],coverageReview:{coveredRequirements:999,totalRequirements:999}},coverage).coverageReview.coveredRequirements,1)
 const all=[row,{...row,id:'T2',requirementRef:'R2'}]
 assert.equal(reviewCoverage(all,coverage).coveredRequirements,2)
 assert.equal(reviewCoverage([all[0]],coverage).coveredRequirements,1)
 assert.equal(reviewCoverage([{...row,expectedResult:'TBD — clarification required'}],coverage).coveredRequirements,0)
 assert.equal(reviewCoverage([row,{...row,id:'T2'}],coverage).coveredRequirements,1)
 assert.throws(()=>validatePreview({cases:[{...row,requirementRef:'R1 R999'}]},coverage),/known requirement/)
 assert.throws(()=>validatePreview({cases:[{...row,requirementRef:'R999'}]},coverage),/known requirement/)
})
test('FSD interpretation filters excluded requirements and verifies excerpts and block grounding',()=>{
 const sources:any[]=[{id:'s',name:'Mixed',kind:'BRD',target:'',text:'MMS Report shows stock. POS allows refunds offline.'}]
 const map={requirements:[{id:'R1',module:'MMS Report',requirement:'Show stock',evidence:[{sourceId:'s',quote:'MMS Report shows stock.'}]},{id:'R2',module:'POS Feature',requirement:'Offline refunds',evidence:[{sourceId:'s',quote:'POS allows refunds offline.'}]}]}
 const result=interpretRequirements(map,sources,['MMS Report'])
 assert.deepEqual(result.requirements.map(r=>r.id),['R1'])
 const preview:any={sections:[{id:'functional',title:'Functional',sourceIds:[],blocks:[{type:'paragraph',text:'Show stock',requirementIds:['R1']}]}],gaps:[],conflicts:[]}
 assert.doesNotThrow(()=>assertFsdGrounding(preview,result.requirements,['MMS Report']))
 assert.deepEqual(preview.sections[0].sourceIds,['s'])
 assert.throws(()=>assertFsdGrounding({...preview,sections:[{...preview.sections[0],blocks:[{type:'paragraph',text:'POS refunds work offline.',requirementIds:['R1']}]}]},result.requirements,['MMS Report']),/excluded/)
 assert.throws(()=>assertFsdGrounding({...preview,sections:[{...preview.sections[0],blocks:[{type:'paragraph',text:'Invented facts',requirementIds:[]}]}]},result.requirements,['MMS Report']),/unsupported/)
})
test('assistant selects urgent older work, calculates full totals, uses names, and discloses partial context',()=>{
 const items=Array.from({length:200},(_,i)=>({id:`i${i}`,title:`Item ${i}`,status:'Open',priority:'Medium',assignedToUserId:'u',clientId:'c'}));items[199]={...items[199],title:'Urgent legacy refund',priority:'Urgent'}
 const state={items,clients:[{id:'c',name:'Client'}],accounts:[{id:'u',name:'BA'}],taskSettings:defaultTaskSettings,workEvents:[{id:'today',date:'2026-09-27',occurredAt:'2026-09-27T16:30:00Z',actorUserId:'u',assignedToUserId:'u',action:'completed',taskId:'i1'}]}
 const result=buildAssistantContext(state,{id:'u',name:'BA',role:'Administrator'}, {},'What should I prioritize this week?','2026-09-28','Asia/Manila',()=>true)
 assert.equal(result.totals.items,200);assert.equal(result.totals.open,200)
 assert.equal(result.openItems[0].id,'i199');assert.equal(result.openItems[0].clientName,'Client')
 assert.equal(result.coverage.partial,true);assert.ok(result.coverageNotice)
 assert.equal(result.myRecentActivity[0].date,'2026-09-28')
 assert.deepEqual(assistantPeriod('last week','2026-09-28'),{from:'2026-09-21',to:'2026-09-27',label:'last week (Monday–Sunday)'})
})
test('Gmail sync reaches later pages, retains a continuation, resumes all labels and avoids duplicate processing',async()=>{
 const visits:string[]=[],cursors:any[]=[]
 const callbacks={list:async(label:string,token?:string)=>({messages:[{id:label==='B'?'A0':`${label}${token||'0'}`}],nextPageToken:label==='A'&&!token?'1':label==='A'&&token==='1'?'2':undefined}),message:async(id:string)=>{visits.push(id)},checkpoint:async(state:any)=>{cursors.push(structuredClone(state))}}
 const first=await syncGmailPages(['A','B'],undefined,callbacks,2)
 assert.equal(first.hasMore,true);assert.deepEqual(visits,['A0'])
 const second=await syncGmailPages(['A','B'],first.state,callbacks,5)
 assert.equal(second.hasMore,false);assert.deepEqual(visits,['A0','A0','A1','A2'])
 const oneRun:string[]=[]
 await syncGmailPages(['A','B'],undefined,{...callbacks,message:async id=>{oneRun.push(id)}})
 assert.deepEqual(oneRun,['A0','A1','A2'])
 const now=1_800_000_000_000, cutoff=Math.floor(now/1000)-10*86400
 assert.equal(gmailWindowStart(undefined,now),cutoff)
 assert.equal(gmailWindowStart({...first.state,windowStart:cutoff},now+60_000),cutoff)
 assert.equal(gmailWindowStart({...first.state,windowStart:cutoff},now+7*3600_000),Math.floor((now+7*3600_000)/1000)-10*86400)
})
test('HTML-only and attachment-backed MIME bodies preserve the full readable message',async()=>{
 const html='<html><head><style>bad</style></head><body><p>Supervisor &amp; QA</p><p>Approve refunds over &#8369;500.</p></body></html>'
 const encoded=Buffer.from(html).toString('base64url')
 assert.equal(await gmailBodyText({mimeType:'text/html',body:{data:encoded}},async()=>''),'Supervisor & QA\n\nApprove refunds over ₱500.')
 assert.equal(await gmailBodyText({mimeType:'text/plain',body:{attachmentId:'body'}},async()=>Buffer.from('Complete long body').toString('base64url')),'Complete long body')
 const text=await gmailBodyText({mimeType:'multipart/alternative',parts:[{mimeType:'text/html',body:{data:encoded}},{mimeType:'text/plain',body:{data:Buffer.from('Plain version').toString('base64url')}}]},async()=>'')
 assert.equal(text,'Plain version')
})
test('business dates roll at tenant midnight independently of UTC',()=>{
 setBusinessTimeZone('Asia/Manila')
 assert.equal(businessDateKey('2026-09-27T15:59:59Z'),'2026-09-27')
 assert.equal(businessDateKey('2026-09-27T16:00:00Z'),'2026-09-28')
})
test('an old rollover does not suppress a later follow-up-today reminder',()=>{
 const state:any={accounts:[{id:'u',role:'Contributor',status:'Active'}],items:[{id:'i',title:'Task',status:'Open',assignedToUserId:'u',followUpDate:'2026-09-28'}],clients:[],projects:[],taskSettings:defaultTaskSettings,workEvents:[{id:'old',taskId:'i',action:'follow_up_auto_moved',date:'2026-09-26',occurredAt:'2026-09-26T00:00:00Z',assignedToUserId:'u'}],notificationState:{initializedAt:'2026-09-25T00:00:00Z'},notifications:[]}
 const result=reconcileNotifications(state,{today:'2026-09-28',now:new Date('2026-09-28T01:00:00Z')})
 assert.ok(result.state.notifications.some((n:any)=>n.type==='follow_up_today'))
})
