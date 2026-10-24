import { useEffect, useState } from 'react'
import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react'

export type ProcessingState = 'idle' | 'working' | 'success' | 'error'

export default function DocumentProcessingPanel({
  state,
  title,
  detail,
  stages,
  activeStage = 0,
  onRetry,
}: {
  state: ProcessingState
  title: string
  detail?: string
  stages: string[]
  activeStage?: number
  onRetry?: () => void
}) {
  const [takingLonger, setTakingLonger] = useState(false)
  useEffect(() => {
    setTakingLonger(false)
    if (state !== 'working') return
    const timer = window.setTimeout(() => setTakingLonger(true), 10000)
    return () => window.clearTimeout(timer)
  }, [state, title])
  if (state === 'idle') return null
  return (
    <section className={`document-processing-panel ${state}`} aria-live="polite" aria-busy={state === 'working'}>
      <div className="document-processing-head">
        <span className="document-processing-icon" aria-hidden="true">
          {state === 'working' ? <i /> : state === 'success' ? <CheckCircle2 size={21} /> : <XCircle size={21} />}
        </span>
        <div>
          <strong>{title}</strong>
          {detail && <p>{detail}</p>}
        </div>
        {state === 'error' && onRetry && (
          <button type="button" className="secondary" onClick={onRetry}>
            <RotateCcw size={14} />
            Try again
          </button>
        )}
      </div>
      {state === 'working' && (
        <>
          <div className="document-processing-bar">
            <span />
          </div>
          <ol className="document-processing-stages">
            {stages.map((stage, index) => (
              <li key={stage} className={index < activeStage ? 'done' : index === activeStage ? 'active' : ''}>
                <span>{index < activeStage ? '✓' : index + 1}</span>
                {stage}
              </li>
            ))}
          </ol>
          {takingLonger && (
            <p className="document-processing-long">
              Still working—large documents may take a few minutes. You can safely keep this page open.
            </p>
          )}
        </>
      )}
    </section>
  )
}
