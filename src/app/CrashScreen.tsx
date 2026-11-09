import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * If a screen throws while drawing, React removes the whole app and leaves a blank page with no way back. This shows
 * what happened instead, with a way to carry on: Reload keeps the person signed in and their saved work.
 */
export default class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The app stopped drawing:', error, info.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <main className="crash-screen" role="alert">
        <h1>Something went wrong on this screen</h1>
        <p>Your saved work is safe. Reload to carry on; if it happens again, send this message to the developer:</p>
        <pre>{error.message || String(error)}</pre>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    )
  }
}
