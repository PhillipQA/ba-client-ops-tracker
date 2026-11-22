/**
 * Pages that download when they are first opened, so sign-in does not wait for every page of the app.
 *
 * - `lazyPage(() => import('./X'), 'Name')` is a page component that loads its file on first render, inside a
 *   <Suspense> (App shows <PageLoading /> from PageLoading.tsx meanwhile). `preload()` starts the download early, on hover or focus.
 * - After a deploy, a page left open from the old build asks for files the server no longer has. The first such
 *   failure reloads the page once, to pick up the new build; a second one in a row is shown as an error.
 */
import { type ComponentType, lazy } from 'react'

const RELOADED = 'ba-chunk-reloaded'

function remember(value: boolean) {
  try {
    if (value) sessionStorage.setItem(RELOADED, '1')
    else sessionStorage.removeItem(RELOADED)
  } catch {
    /* Storage blocked: at worst a failed load shows its error instead of reloading. */
  }
}
function reloadedAlready() {
  try {
    return sessionStorage.getItem(RELOADED) === '1'
  } catch {
    return true
  }
}

/** A failed page download: reload once for a newer build, otherwise let the error show. */
export function recoverFromStaleBuild(error: unknown, reload: () => void = () => window.location.reload()): Promise<never> {
  if (reloadedAlready()) {
    remember(false)
    return Promise.reject(error)
  }
  remember(true)
  reload()
  return new Promise<never>(() => {})
}

export type LazyPage<P> = ComponentType<P> & { preload: () => void }

export function lazyPage<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
): LazyPage<M[K] extends ComponentType<infer P> ? P : never> {
  let fetching: Promise<M> | null = null
  const fetchModule = () => {
    if (!fetching)
      fetching = load().catch(error => {
        fetching = null
        throw error
      })
    return fetching
  }
  const Page = lazy(() =>
    fetchModule().then(module => {
      remember(false)
      return { default: module[name] as ComponentType<any> }
    }, recoverFromStaleBuild),
  ) as unknown as LazyPage<any>
  // Hover or focus: download early. A failure here stays quiet; opening the page deals with it.
  Page.preload = () => {
    fetchModule().catch(() => {})
  }
  return Page
}
