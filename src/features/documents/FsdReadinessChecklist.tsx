import React from 'react'
import { suggestedFsdInput, type FsdReadinessIssue } from './fsd-readiness'
import type { FsdPreview } from './fsd-model'

export default function FsdReadinessChecklist({ issues, preview }: { issues: FsdReadinessIssue[]; preview: FsdPreview | null }) {
  const known = new Set(issues.map(issue => issue.missing))
  const extra: FsdReadinessIssue[] = (preview?.gaps || []).filter(gap => !known.has(gap) && !issues.some(issue => gap.includes(issue.missing))).map((gap, i) => ({ id: `preview-gap-${i}`, title: 'Preview — pending information', missing: gap, add: suggestedFsdInput(gap) }))
  const all = [...issues, ...extra]
  const entry = (issue: FsdReadinessIssue) => <li key={issue.id}><strong>{issue.title}</strong><small>{issue.category === 'unavailable' ? 'Unavailable input' : 'Missing data / clarification'}</small><p>{issue.missing}</p><p><b>What to add:</b> {issue.add}</p></li>
  return <div className="fsd-readiness" role="status" aria-label="Information needed for a fuller FSD">
    <h4>Information needed for a fuller FSD</h4>
    <p>Only documents explicitly referenced by your inputs can be identified as missing by name. Other items describe missing data and suitable evidence. A formal BRD or a specific document type is not required. You can upload a relevant file or paste notes answering the points below.</p>
    {all.length ? <><ul>{all.slice(0, 4).map(entry)}</ul>{all.length > 4 && <details><summary>Show {all.length - 4} more items</summary><ul>{all.slice(4).map(entry)}</ul></details>}<small>Generate anyway uses available facts and keeps missing selected sections as TBD / Pending information.</small></> : <p>No missing information was identified by the current source reviews. Check the generated preview for further questions.</p>}
  </div>
}

