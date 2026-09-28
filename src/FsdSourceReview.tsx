import { Sparkles } from 'lucide-react'
import type { FsdSource } from './fsd-model'

export function sourceReviewLabel(source: FsdSource, excluded: boolean, working: boolean) {
  if (excluded) return 'Excluded by scope'
  if (working) return 'AI reviewing…'
  if (source.analysisError) return 'Review failed'
  if (!source.analysis) return 'AI review needed'
  if (!source.analysis.complete) return 'Incomplete review'
  return {readable:'Readable',partial:'Needs review',unreadable:'Unreadable'}[source.analysis.readability]
}

export default function FsdSourceReview({source,excluded,working,onAnalyze}:{source:FsdSource;excluded:boolean;working:boolean;onAnalyze:()=>void}) {
  if (excluded) return <p className="fsd-warning">This source is excluded by scope. Its content will not be sent for AI review or FSD generation.</p>
  const analysis=source.analysis
  return <section className="fsd-source-review" aria-label={`AI review of ${source.name}`} aria-live="polite">
    <div className="fsd-source-review-heading"><strong>{sourceReviewLabel(source,false,working)}</strong><button type="button" className="secondary" onClick={onAnalyze} disabled={working}><Sparkles size={14}/>{analysis?'Reanalyze source':source.analysisError?'Retry AI review':'Analyze source'}</button></div>
    {source.analysisError&&<p className="fsd-warning">{source.analysisError}</p>}
    {!analysis&&!source.analysisError&&<p>AI review runs after upload. If you edit the text or scope, analyze it again to update the interpretation.</p>}
    {analysis&&<>
      <p>{analysis.summary}</p>
      <small>{analysis.provider} · {analysis.model} · {analysis.requirements.length} supported facts / requirements. Verify the interpretation against the excerpts.</small>
      {analysis.gaps.length>0&&<div className="fsd-source-questions"><strong>Questions and reading limitations</strong><ul>{analysis.gaps.map((gap,i)=><li key={i}>{gap}</li>)}</ul></div>}
      {analysis.requirements.length>0&&<details><summary>What the AI understood ({analysis.requirements.length})</summary>{analysis.requirements.map(r=><article key={r.id}><strong>{r.module}</strong><p>{r.requirement}</p>{r.evidence.map((e,i)=><blockquote key={i}>{e.quote}</blockquote>)}</article>)}</details>}
    </>}
  </section>
}
