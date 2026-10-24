import { RotateCcw } from 'lucide-react'

export default function DocumentReset({
  label,
  onReset,
  disabled = false,
}: {
  label: string
  onReset: () => void
  disabled?: boolean
}) {
  return (
    <div className="document-reset-bar">
      <small>Reset clears this document’s inputs, uploads and generated preview, then restores form defaults.</small>
      <button type="button" className="secondary" disabled={disabled} onClick={onReset}>
        <RotateCcw size={16} />
        Reset {label}
      </button>
    </div>
  )
}
