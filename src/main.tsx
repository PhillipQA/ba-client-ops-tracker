import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './fonts.css'
import './styles.css'
import './appearance.css'
import './sidebar.css'

// A tab opened before a deploy can ask for a code chunk the new build no longer has.
// Reload once to pick up the current index.html; the timestamp guard prevents a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const key = 'ba-preload-reload-at'
  let last = 0
  try { last = Number(sessionStorage.getItem(key)) || 0 } catch { /* storage unavailable */ }
  if (Date.now() - last < 30_000) return
  try { sessionStorage.setItem(key, String(Date.now())) } catch { /* storage unavailable */ }
  event.preventDefault()
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
