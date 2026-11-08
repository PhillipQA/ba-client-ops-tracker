import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Request, Response, NextFunction } from 'express'
import { APP_RELEASE } from '../../src/shared/version'

// Render recommends longer timeouts when its proxy reuses Node connections.
// Keep the header timeout above the idle timeout; request limits stay unchanged.
export function configureHttpServer(server: Server) {
  server.keepAliveTimeout = 120_000
  server.headersTimeout = 130_000
}

export function authRequestDiagnostics(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST' || !['/login', '/logout'].includes(req.path)) return next()

  const suppliedId = req.get('X-Auth-Request-Id') || ''
  const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId)
    ? suppliedId
    : randomUUID()
  const action = req.path === '/login' ? 'login' : 'logout'
  const startedAt = Date.now()
  res.setHeader('X-Auth-Request-Id', requestId)
  res.setHeader('X-Auth-App-Version', APP_RELEASE)
  const record = (event: string, status?: number) => {
    // Deliberately log no bodies, cookies, credentials, usernames, or IPs.
    console.info(
      '[auth]',
      JSON.stringify({ event, requestId, action, version: APP_RELEASE, status, durationMs: Date.now() - startedAt }),
    )
  }
  record('started')
  res.once('finish', () => record('completed', res.statusCode))
  res.once('close', () => {
    if (!res.writableFinished) record('closed_before_response')
  })
  next()
}
