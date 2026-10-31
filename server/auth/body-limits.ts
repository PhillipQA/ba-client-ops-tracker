import type { Request, RequestHandler } from 'express'

/**
 * JSON request bodies. A signed-in person's requests may carry large uploads (evidence files, documents, imports) up
 * to the large limit. Anything else (sign-in, password recovery, or a request without a valid session, which every
 * other route refuses anyway) is read with the small limit, so an anonymous caller cannot make the server parse tens
 * of megabytes per request.
 */
export const BODY_LIMITS = { signedIn: '24mb', anonymous: '100kb' } as const

export function jsonBodies(deps: {
  /** The JSON body parser to use, such as express.json. */
  json: (options: { limit: string }) => RequestHandler
  /** True when the request carries a valid session. */
  signedIn: (req: Request) => boolean
}): RequestHandler {
  const large = deps.json({ limit: BODY_LIMITS.signedIn })
  const small = deps.json({ limit: BODY_LIMITS.anonymous })
  return (req, res, next) => (deps.signedIn(req) ? large : small)(req, res, next)
}
