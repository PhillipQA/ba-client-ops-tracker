import { useEffect, type RefObject } from 'react'

/**
 * Opens a <dialog> as a modal on the browser's top layer while the component is mounted: the page behind stops
 * scrolling, and focus goes back to where it was when the dialog closes. The top layer escapes themed panels'
 * backdrop-filter, clipping and stacking, which is why every dialog in the app uses it.
 * `onOpen` runs right after opening, for example to focus the first field.
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  onOpen?: (element: HTMLDialogElement) => void,
) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const returnFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    if (!element.open) element.showModal()
    document.body.style.overflow = 'hidden'
    onOpen?.(element)
    return () => {
      element.close()
      document.body.style.overflow = previousOverflow
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true })
    }
    // Opened once, when the dialog mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
