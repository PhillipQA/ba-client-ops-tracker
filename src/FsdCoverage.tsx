import type { FsdPreview, FsdSource } from './fsd-model'

export default function FsdCoverage({ preview, sources }: { preview: FsdPreview; sources: FsdSource[] }) {
  const coverage = preview.sourceCoverage
  if (!coverage) return null
  const name = (id: string) => sources.find(s => s.id === id)?.name || id
  const contributing = coverage.contributingSourceIds || coverage.usedSourceIds.filter(id => preview.requirements?.some(r => r.evidence.some(e => e.sourceId === id)))
  return <details className="fsd-card" open><summary>Input coverage — every supplied source</summary><ul>
    {contributing.map(id => <li key={id}><strong>{name(id)}</strong>: {coverage.partialSourceIds.includes(id) ? 'Partially used — verified facts retained; unclear content remains pending.' : 'Contributed supported requirements.'}</li>)}
    {(coverage.noRelevantSourceIds || coverage.usedSourceIds.filter(id => !contributing.includes(id))).map(id => <li key={id}><strong>{name(id)}</strong>: Reviewed; no relevant requirements identified.{coverage.partialSourceIds.includes(id) ? ' Reading was partial.' : ''}</li>)}
    {coverage.skippedSources.map(s => <li key={s.id}><strong>{s.name}</strong>: Skipped — {s.reason}</li>)}
    {coverage.excludedSources?.map(s => <li key={s.id}><strong>{s.name}</strong>: Excluded — {s.reason}</li>)}
    {preview.uploadFailures?.map(s => <li key={s.id}><strong>{s.name}</strong>: Upload unavailable — {s.reason}</li>)}
  </ul></details>
}
