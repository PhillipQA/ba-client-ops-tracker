import { useId, useRef, type ReactNode } from 'react'
import { useModalDialog } from './useModalDialog'
import { Minus, X } from 'lucide-react'

/** A modal on the browser's top layer, so themed panels and clipping never hide it. */
export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide,
  size,
  busy,
  className = '',
  bodyClassName,
  onMinimize,
}: {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  /** wide (980px) or medium (680px); the default is 560px. `wide` is kept for older callers. */
  wide?: boolean
  size?: 'medium' | 'wide'
  /** While busy, Escape and the close button do nothing. */
  busy?: boolean
  className?: string
  /** Wraps the content, for callers whose content has no padding of its own. */
  bodyClassName?: string
  /** Shows a Minimize button beside Close (task windows, which can be put aside in a dock). */
  onMinimize?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useModalDialog(ref)
  return (
    <dialog
      ref={ref}
      className={`k-dialog${wide || size === 'wide' ? ' wide' : size === 'medium' ? ' medium' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="k-dialog-head">
        <div>
          {eyebrow && <p>{eyebrow}</p>}
          <h2 id={titleId}>{title}</h2>
        </div>
        <span className="k-dialog-head-actions">
          {onMinimize && (
            <button
              type="button"
              className="k-dialog-close"
              aria-label="Minimize"
              title="Minimize: keep it at the bottom of the screen"
              disabled={busy}
              onClick={onMinimize}
            >
              <Minus size={18} />
            </button>
          )}
          <button type="button" className="k-dialog-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </dialog>
  )
}
