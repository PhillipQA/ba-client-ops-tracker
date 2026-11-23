import express, { type Express } from 'express'
import path from 'node:path'
import { precompressedAssets } from './compression'

// Serves the built frontend in production.
//
// Vite gives every build's JS/CSS a content hash (assets/index-AbC123.js), so those files can be
// cached forever. index.html is the only file that names the current hashes, so browsers must
// revalidate it on every load. Without that, a browser (or a corporate proxy) keeps an old
// index.html that points at assets removed by a newer deploy.
//
// A request for a missing file under /assets must return 404. Falling through to the SPA route
// would send index.html as text/html, which browsers reject as a script or stylesheet
// ("Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html").
export function registerStaticSite(app: Express, dist: string) {
  const noCache = 'no-cache'

  // The Brotli or gzip copy made at build time, when the browser accepts it (compression.ts).
  app.use('/assets', precompressedAssets(path.join(dist, 'assets')))
  app.use(
    '/assets',
    express.static(path.join(dist, 'assets'), {
      immutable: true,
      maxAge: '1y',
      index: false,
      fallthrough: false,
    }),
  )
  // fallthrough:false hands missing files to the error handler; answer with a plain 404 instead.
  app.use('/assets', ((err, _req, res, next) => {
    if (err?.status === 404 || err?.statusCode === 404) {
      res.setHeader('Cache-Control', 'no-store')
      return void res.status(404).type('text/plain').send('Not found')
    }
    next(err)
  }) as express.ErrorRequestHandler)

  app.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', noCache)
      },
    }),
  )

  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', noCache)
    res.sendFile(path.join(dist, 'index.html'))
  })
}
