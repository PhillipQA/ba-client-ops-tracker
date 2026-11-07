/**
 * Real addresses for the app's pages, so the browser's Back and Forward buttons, refresh, bookmarks and "open in new
 * tab" work like on any website. Pure functions, used by useAppState, Trackers and tests.
 *
 *   /                      My Action Center        /trackers            Trackers
 *   /tasks                 Tasks                   /trackers/<id>       One tracker
 *   /clients/<id>          One client              /projects/<id>       One project (?client=<id> when opened from one)
 *
 * The production server answers every non-API address with index.html (see server/platform/static-site.ts).
 */
import type { View } from './navigation'

export const VIEW_PATHS: Record<View, string> = {
  action: '/',
  clients: '/clients',
  projects: '/projects',
  inbox: '/work-hub',
  items: '/tasks',
  documents: '/documents',
  requirements: '/requirements',
  trackers: '/trackers',
  reports: '/reports',
  ai: '/ai',
  settings: '/settings',
  'internal-admin': '/internal-admin',
  users: '/users',
  themes: '/themes',
  seeds: '/seeds',
}

export type Route = {
  view: View
  clientId: string | null
  projectId: string | null
  /** The client a project was opened from, so its Back button returns there. */
  projectClientId: string | null
}

const viewOfSegment = new Map(
  (Object.entries(VIEW_PATHS) as [View, string][])
    .filter(([, path]) => path !== '/')
    .map(([view, path]) => [path.slice(1), view]),
)

const decode = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
const segmentsOf = (pathname: string) => pathname.split('/').filter(Boolean)

/** The page an address points to, or `null` for an address the app does not know (treated as the start page). */
export function routeFromLocation(pathname: string, search = ''): Route | null {
  const [first, second] = segmentsOf(pathname)
  if (!first) return { view: 'action', clientId: null, projectId: null, projectClientId: null }
  const view = viewOfSegment.get(first.toLowerCase())
  if (!view) return null
  const id = second ? decode(second) : null
  if (view === 'clients') return { view, clientId: id, projectId: null, projectClientId: null }
  if (view === 'projects') {
    const client = id ? new URLSearchParams(search).get('client') : null
    return { view, clientId: null, projectId: id, projectClientId: client || null }
  }
  return { view, clientId: null, projectId: null, projectClientId: null }
}

/** The address of a page. A selected project wins over a selected client, as on screen. */
export function pathForRoute(route: Route): string {
  if (route.projectId)
    return `/projects/${encodeURIComponent(route.projectId)}${
      route.projectClientId ? `?client=${encodeURIComponent(route.projectClientId)}` : ''
    }`
  if (route.clientId) return `/clients/${encodeURIComponent(route.clientId)}`
  return VIEW_PATHS[route.view]
}

/**
 * Whether the browser is already at this page. A page can own deeper addresses of its own: Trackers keeps the open
 * tracker in `/trackers/<id>`, so the app does not overwrite that with `/trackers`.
 */
export function atRoute(pathname: string, search: string, target: string): boolean {
  const here = pathname.replace(/\/+$/, '') || '/'
  if (`${here}${search}` === target) return true
  return target === VIEW_PATHS.trackers && here.startsWith(`${VIEW_PATHS.trackers}/`)
}

/** The tracker an address opens, or '' for the tracker list (or an address outside Trackers). */
export function trackerIdFromPath(pathname: string): string {
  const [first, second] = segmentsOf(pathname)
  return first === VIEW_PATHS.trackers.slice(1) && second ? decode(second) : ''
}

export const pathForTracker = (id: string) =>
  id ? `${VIEW_PATHS.trackers}/${encodeURIComponent(id)}` : VIEW_PATHS.trackers

/** A click that should open the page in a new tab or window instead (Ctrl/⌘-click, Shift-click, middle click). */
export const opensElsewhere = (event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; button: number }) =>
  event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1
