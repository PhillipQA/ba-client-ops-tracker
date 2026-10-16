import type { NextFunction, Request, Response } from 'express'

/**
 * Baseline response headers for every route.
 * - nosniff stops a browser treating an uploaded evidence file as HTML or script because of its content.
 * - frame-ancestors / X-Frame-Options keep the app from being embedded in another site (clickjacking).
 * - HSTS is sent only in production, where TLS is terminated in front of the app.
 * A full Content-Security-Policy is deliberately not set here: it has to be tuned against the real UI
 * (Vite output, inline styles, Google sign-in) and checked in a browser first.
 */
export function securityHeaders(options: { production: boolean }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (options.production) res.setHeader('Strict-Transport-Security', 'max-age=15552000')
    next()
  }
}
