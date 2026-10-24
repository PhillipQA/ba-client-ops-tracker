/**
 * The one way the browser talks to the server: JSON in, JSON out, the person's session cookie included.
 * A failed request throws HttpError with the server's own `error` message, or the caller's fallback when the server
 * gave none. Features keep their own wording by passing `fallback`, and their own error classes by passing `error`.
 */
export class HttpError extends Error {
  constructor(message: string, public status: number, public body: Record<string, any> = {}) { super(message) }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type HttpOptions = {
  method?: HttpMethod
  /** Sent as JSON. A request with a body defaults to POST. */
  body?: unknown
  signal?: AbortSignal
  /** The message when the server does not say what went wrong. */
  fallback?: string
  /** The message when the server cannot be reached at all. Without it the browser's own error is passed on. */
  offline?: string
  /** Messages for particular statuses when the server gives none, e.g. { 403: 'You do not have access.' }. */
  statusFallback?: Record<number, string>
  /** Answer codes that are not failures even when the status is (e.g. a file that was already saved). */
  acceptCodes?: string[]
  /** Builds the error to throw, for features with their own error classes. */
  error?: (message: string, status: number, body: Record<string, any>) => Error
  credentials?: RequestCredentials
  /** Ask the browser not to reuse a cached answer. */
  noStore?: boolean
  /** Leave out the JSON content type on requests without a body (some routes never needed it). */
  bare?: boolean
}

export async function requestJson<T = any>(url: string, options: HttpOptions = {}): Promise<T> {
  const hasBody = options.body !== undefined
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method || (hasBody ? 'POST' : 'GET'),
      credentials: options.credentials || 'same-origin',
      ...(options.noStore ? { cache: 'no-store' as RequestCache } : {}),
      // Some routes accept changes only when they are marked as JSON, even without a body.
      headers: hasBody || !options.bare ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' || !options.offline) throw error
    throw options.error ? options.error(options.offline, 0, {}) : new HttpError(options.offline, 0)
  }
  const text = await response.text()
  let data: Record<string, any> = {}
  // A proxy or a crash can answer with HTML; that is treated as an empty answer.
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!response.ok && !(typeof data.code === 'string' && options.acceptCodes?.includes(data.code))) {
    const message = typeof data.error === 'string' && data.error ? data.error : options.statusFallback?.[response.status] || options.fallback || 'The request could not be completed.'
    throw options.error ? options.error(message, response.status, data) : new HttpError(message, response.status, data)
  }
  return data as T
}

/** Shorthands for the common cases. */
export const http = {
  get: <T = any>(url: string, options: Omit<HttpOptions, 'method' | 'body'> = {}) => requestJson<T>(url, { ...options, method: 'GET' }),
  post: <T = any>(url: string, body?: unknown, options: Omit<HttpOptions, 'method' | 'body'> = {}) => requestJson<T>(url, { ...options, method: 'POST', body }),
  put: <T = any>(url: string, body?: unknown, options: Omit<HttpOptions, 'method' | 'body'> = {}) => requestJson<T>(url, { ...options, method: 'PUT', body }),
  patch: <T = any>(url: string, body?: unknown, options: Omit<HttpOptions, 'method' | 'body'> = {}) => requestJson<T>(url, { ...options, method: 'PATCH', body }),
  delete: <T = any>(url: string, options: Omit<HttpOptions, 'method' | 'body'> = {}) => requestJson<T>(url, { ...options, method: 'DELETE' }),
}
