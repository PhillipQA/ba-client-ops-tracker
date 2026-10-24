import type express from 'express'

/** The only changes a platform administrator may make while the bootstrap password is still in use. */
const ALLOWED_BEFORE_PASSWORD_CHANGE = new Set(['/api/internal-admin/password', '/api/internal-admin/recovery-email'])

export function requirePlatformAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (
    req as express.Request & {
      authUser?: { isPlatformAdmin?: boolean; accountType?: string; mustChangePassword?: boolean }
    }
  ).authUser
  if (!user?.isPlatformAdmin || user.accountType !== 'platform') {
    res.status(403).json({ error: 'BXI-Core platform administrator access is required.' })
    return
  }
  // The bootstrap password comes from a deployment setting, so it is not a secret the administrator alone holds.
  // Until it is replaced the account may look around, but cannot change anything except its own credentials.
  if (user.mustChangePassword && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const path = String(req.originalUrl || req.url || '')
      .split('?')[0]
      .replace(/\/+$/, '')
    if (!ALLOWED_BEFORE_PASSWORD_CHANGE.has(path)) {
      res.status(403).json({
        error: 'Change the Internal Admin bootstrap password before making other changes.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      })
      return
    }
  }
  next()
}
