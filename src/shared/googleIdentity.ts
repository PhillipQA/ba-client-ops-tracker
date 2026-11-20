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

/**
 * Google's library must be set up once per page: setting it up again ("initialize() is called multiple times") can
 * leave its button dead after a sign-in, for example after a failed Google sign-in, Change account, Continue. So it is
 * set up once per client ID, and every Google button hands the answer to whoever asked last (`useGoogleCredential`).
 * Returns the library, ready for renderButton.
 */
let initializedFor = ''
let receive: (credential: string) => void = () => {}

export async function googleWithHandler(clientId: string, onCredential: (credential: string) => void) {
  // Taken over at once, so a button that goes away while Google loads cannot take it back afterwards.
  receive = onCredential
  await loadGoogle()
  const google = (window as any).google
  if (initializedFor !== clientId) {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: (response: { credential?: string }) => {
        if (response.credential) receive(response.credential)
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    })
    initializedFor = clientId
  }
  return google
}

/** A button that goes away stops receiving answers, unless another has taken over since. */
export function releaseGoogleHandler(onCredential: (credential: string) => void) {
  if (receive === onCredential) receive = () => {}
}
