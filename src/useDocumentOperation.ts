import { useCallback, useEffect, useRef } from 'react'

// A reset invalidates every callback from the old draft, including local OCR
// work which cannot be interrupted by a fetch AbortSignal.
export function useDocumentOperation() {
  const current = useRef<AbortController | null>(null)
  const cancel = useCallback(() => {
    current.current?.abort()
    current.current = null
  }, [])
  const begin = useCallback(() => {
    cancel()
    const controller = new AbortController()
    current.current = controller
    return {
      signal: controller.signal,
      isCurrent: () => current.current === controller && !controller.signal.aborted,
    }
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { begin, cancel }
}
