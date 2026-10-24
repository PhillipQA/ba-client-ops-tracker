import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react'

type Tip = { label: string; top: number; left: number }
type TipHandlers = {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave?: () => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: () => void
}

/**
 * Name tags for the icon-only menu. Hovering or tabbing to an icon shows what it is, beside the icon.
 * The tag is drawn at a fixed position outside the menu, so the menu's own scrolling cannot clip it.
 * The buttons keep their text (hidden from sight, not from screen readers), so the tag is decoration.
 */
export function useRailTip(enabled: boolean): {
  bind: (label: string) => TipHandlers
  hide: () => void
  tip: ReactNode
} {
  const [tip, setTip] = useState<Tip | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const clear = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }, [])
  const hide = useCallback(() => {
    clear()
    setTip(null)
  }, [clear])
  const show = useCallback(
    (element: HTMLElement, label: string, delay: number) => {
      clear()
      const place = () => {
        const box = element.getBoundingClientRect()
        setTip({ label, top: box.top + box.height / 2, left: box.right + 10 })
      }
      if (delay) timer.current = window.setTimeout(place, delay)
      else place()
    },
    [clear],
  )

  useEffect(() => {
    if (!enabled) {
      hide()
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
      clear()
    }
  }, [enabled, hide, clear])

  const bind = useCallback(
    (label: string): TipHandlers =>
      enabled
        ? {
            onMouseEnter: (event: MouseEvent<HTMLElement>) => show(event.currentTarget, label, 120),
            onMouseLeave: hide,
            onFocus: (event: FocusEvent<HTMLElement>) => {
              if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget, label, 0)
            },
            onBlur: hide,
          }
        : {},
    [enabled, show, hide],
  )

  return {
    bind,
    hide,
    tip:
      enabled && tip ? (
        <div className="rail-tip" aria-hidden="true" style={{ top: tip.top, left: tip.left }}>
          {tip.label}
        </div>
      ) : null,
  }
}
