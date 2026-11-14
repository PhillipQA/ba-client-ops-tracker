import { Dialog } from '../shared/ui'

/** The app's add and edit windows (task, client, project, activity), on the shared dialog. */
export function Modal({
  title,
  onClose,
  closeDisabled = false,
  onMinimize,
  children,
}: {
  title: string
  onClose: () => void
  closeDisabled?: boolean
  onMinimize?: () => void
  children: React.ReactNode
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={closeDisabled}
      size="medium"
      className="modal app-modal"
      onMinimize={onMinimize}
    >
      {children}
    </Dialog>
  )
}
