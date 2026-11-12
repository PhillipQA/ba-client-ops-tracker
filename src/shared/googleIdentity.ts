/** Google Identity Services, loaded once when a Google sign-in is first needed (login page, sending time to Seeds). */
let script: Promise<void> | null = null

export function loadGoogle() {
  script ||= new Promise<void>((resolve, reject) => {
    if ((window as any).google?.accounts?.id) return resolve()
    const tag = document.createElement('script')
    tag.src = 'https://accounts.google.com/gsi/client'
    tag.async = true
    tag.onload = () => resolve()
    tag.onerror = () => {
      script = null
      reject(new Error('Google sign-in could not load. Check the connection and try again.'))
    }
    document.head.appendChild(tag)
  })
  return script
}
