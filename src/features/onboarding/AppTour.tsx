// The guided tour: one step at a time, the rest of the page dimmed and the part being explained lit up, with a card
// beside it. Steps without something to light up (the welcome, or a part not on this screen) show a card in the middle.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import type { TourStep, TourView } from './tourSteps'
import './tour.css'

type Rect = { top: number; left: number; width: number; height: number }
const PAD = 6
const CARD_WIDTH = 360
const GAP = 14

/** Waits for a selector to appear (pages render after navigation), for up to `ms`. */
function waitFor(selector: string, ms = 1500): Promise<HTMLElement | null> {
  return new Promise(resolve => {
    const started = performance.now()
    const look = () => {
      const found = document.querySelector<HTMLElement>(selector)
      if (found?.getClientRects().length) return resolve(found)
      if (performance.now() - started > ms) return resolve(null)
      requestAnimationFrame(look)
    }
    look()
  })
}

export default function AppTour({
  steps,
  onNavigate,
  onClose,
}: {
  steps: TourStep[]
  onNavigate: (view: TourView) => void
  /** Finished or skipped: either way the tour does not start by itself again. */
  onClose: (finished: boolean) => void
}) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [ready, setReady] = useState(false)
  const target = useRef<HTMLElement | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const step = steps[index]
  const last = index === steps.length - 1

  const measure = useCallback(() => {
    const element = target.current
    if (!element?.isConnected) return setRect(null)
    const box = element.getBoundingClientRect()
    setRect({ top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 })
  }, [])

  // Each step: open its page, press its tab, then find and light up its part of the screen.
  useEffect(() => {
    let cancelled = false
    setReady(false)
    target.current = null
    setRect(null)
    void (async () => {
      if (step.view) onNavigate(step.view)
      if (step.click) (await waitFor(step.click))?.click()
      const found = step.target ? await waitFor(step.target) : null
      if (cancelled) return
      target.current = found
      found?.scrollIntoView({ block: 'center', inline: 'nearest' })
      // After scrolling settles.
      requestAnimationFrame(() => {
        if (cancelled) return
        measure()
        setReady(true)
      })
    })()
    return () => {
      cancelled = true
    }
  }, [index])

  useEffect(() => {
    const again = () => measure()
    window.addEventListener('resize', again)
    window.addEventListener('scroll', again, true)
    return () => {
      window.removeEventListener('resize', again)
      window.removeEventListener('scroll', again, true)
    }
  }, [measure])

  const next = () => (last ? onClose(true) : setIndex(value => value + 1))
  const back = () => setIndex(value => Math.max(0, value - 1))
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(false)
      else if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') back()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  })
  useEffect(() => {
    if (ready) card.current?.focus()
  }, [ready, index])

  // The card goes below the lit part, or above it, or beside it, kept inside the window.
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!rect || !card.current) return setPlace(null)
    const height = card.current.offsetHeight
    const width = Math.min(CARD_WIDTH, window.innerWidth - 24)
    const room = { below: window.innerHeight - (rect.top + rect.height), above: rect.top }
    let top: number, left: number
    if (room.below >= height + GAP) top = rect.top + rect.height + GAP
    else if (room.above >= height + GAP) top = rect.top - height - GAP
    else top = Math.max(12, Math.min(window.innerHeight - height - 12, rect.top))
    if (room.below >= height + GAP || room.above >= height + GAP) left = rect.left
    else
      left =
        rect.left + rect.width + GAP > window.innerWidth - width
          ? rect.left - width - GAP
          : rect.left + rect.width + GAP
    left = Math.max(12, Math.min(window.innerWidth - width - 12, left))
    setPlace({ top: Math.max(12, top), left })
  }, [rect, index, ready])

  const lit = Boolean(rect && ready)
  return createPortal(
    <div className="app-tour" role="presentation">
      {/* Clicks on the dimmed page are caught, so the tour is not lost by accident. */}
      <div className={`app-tour-shade${lit ? ' is-clear' : ''}`} />
      {lit && rect && (
        <div
          className="app-tour-spotlight"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      )}
      <div
        ref={card}
        className={`app-tour-card${lit ? '' : ' is-centered'}`}
        style={lit ? (place ? { top: place.top, left: place.left } : { top: -9999, left: -9999 }) : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-ready={ready}
      >
        <div className="app-tour-head">
          <span className="app-tour-section">{step.section}</span>
          <button type="button" className="app-tour-close" aria-label="Skip the tour" onClick={() => onClose(false)}>
            <X size={16} />
          </button>
        </div>
        <h2 id={titleId}>{step.title}</h2>
        <p>{step.body}</p>
        {step.points && (
          <ul>
            {step.points.map(point => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        )}
        <div className="app-tour-progress" aria-hidden="true">
          {steps.map((item, at) => (
            <span key={item.id} className={at === index ? 'on' : at < index ? 'done' : ''} />
          ))}
        </div>
        <div className="app-tour-actions">
          <span className="app-tour-count">
            {index + 1} of {steps.length}
          </span>
          {index === 0 ? (
            <button type="button" className="secondary" onClick={() => onClose(false)}>
              Skip
            </button>
          ) : (
            <button type="button" className="secondary" onClick={back}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
          <button type="button" className="primary" onClick={next}>
            {index === 0 ? 'Start the tour' : last ? 'Finish' : 'Next'} {!last && <ArrowRight size={15} />}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
