import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import CrashScreen from './app/CrashScreen'
import LongSelectSearch from './shared/ui/LongSelectSearch'
import './styles/fonts.css'
import './styles/styles.css'
import './shared/ui/ui.css'
import './styles/appearance.css'
import './styles/sidebar.css'

// A tab opened before a deploy can ask for a code chunk the new build no longer has.
// Reload once to pick up the current index.html; the timestamp guard prevents a reload loop.
window.addEventListener('vite:preloadError', event => {
  const key = 'ba-preload-reload-at'
  let last = 0
  try {
    last = Number(sessionStorage.getItem(key)) || 0
  } catch {
    /* storage unavailable */
  }
  if (Date.now() - last < 30_000) return
  try {
    sessionStorage.setItem(key, String(Date.now()))
  } catch {
    /* storage unavailable */
  }
  event.preventDefault()
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashScreen>
      <App />
      <LongSelectSearch />
    </CrashScreen>
  </React.StrictMode>,
)
