import type express from 'express'
export function requirePlatformAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as express.Request & { authUser?: { isPlatformAdmin?: boolean; accountType?: string } }).authUser
  if (!user?.isPlatformAdmin || user.accountType !== 'platform') {
    res.status(403).json({ error: 'BXI-Core platform administrator access is required.' })
    return
  }
  next()
}

