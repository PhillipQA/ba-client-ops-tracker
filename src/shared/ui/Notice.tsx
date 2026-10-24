import type { ReactNode } from 'react'
import { X } from 'lucide-react'

/** A short message above content: an error, or information. */
export function Notice({
  kind,
  children,
  onClose,
}: {
  kind: 'error' | 'info'
  children: ReactNode
  onClose?: () => void
}) {
  return (
    <div className={`k-notice k-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onClose && (
        <button type="button" className="k-dialog-close small" aria-label="Dismiss" onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
