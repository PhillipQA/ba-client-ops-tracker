import type { RequestHandler } from 'express'

/**
 * The Document Creation routes (BRD, FSD, test cases): the person needs the Documents page, and may not create
 * documents as a Viewer. Answers are never cached.
 */
export const documentGuard: RequestHandler = (req, res, next) => {
  const user = (req as any).authUser
  if (!user.modules?.includes('documents') || (req.method === 'POST' && user.role === 'Viewer'))
    return void res.status(403).json({ error: 'Document Creation access with write permission is required.' })
  res.setHeader('Cache-Control', 'no-store')
  next()
}
