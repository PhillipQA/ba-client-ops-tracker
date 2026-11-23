/**
 * Smaller downloads, with Node's own zlib (no extra packages).
 *
 * - Built files: `npm run build` writes a Brotli (.br) and a gzip (.gz) copy next to each JS, CSS, SVG and JSON
 *   file in dist/assets (scripts/compress-dist.mjs). `precompressedAssets` sends the smallest copy the browser
 *   accepts, with the same long-term caching; files without copies are served as before.
 * - API answers: `compressJson` compresses JSON answers larger than 8 KB (the workspace, tracker rows, reports)
 *   for browsers that accept it. Small answers and HEAD requests are sent as they are.
 *
 * Only compressing happens here; nothing sent by browsers is decompressed.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export type Encoding = 'br' | 'gzip'

/** The best encoding the browser accepts ('' when none): Brotli, then gzip. A q=0 entry means "not this one". */
export function pickEncoding(header: unknown): Encoding | '' {
  const accepted = new Set<string>()
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='))
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name)
  }
  if (accepted.has('br')) return 'br'
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip'
  return ''
}

/** Smallest JSON answer worth compressing. */
export const COMPRESS_MIN_BYTES = 8 * 1024

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Serves dist/assets/<file> from <file>.br or <file>.gz when the browser accepts it and the copy exists. The list
 * of copies is read once at start: a build never changes while the server runs.
 */
export function precompressedAssets(assetsDir: string): RequestHandler {
  const copies = new Set<string>()
  const scan = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) scan(full, `${prefix}${name}/`)
      else if (name.endsWith('.br') || name.endsWith('.gz')) copies.add(`${prefix}${name}`)
    }
  }
  scan(assetsDir, '')
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const file = decodeURIComponent(req.path.replace(/^\/+/, ''))
    const type = TYPES[path.extname(file)]
    if (!type || file.includes('..')) return next()
    res.setHeader('Vary', 'Accept-Encoding')
    const encoding = pickEncoding(req.headers['accept-encoding'])
    const suffix = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : ''
    if (!suffix || !copies.has(file + suffix)) return next()
    res.setHeader('Content-Encoding', encoding)
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.sendFile(path.join(assetsDir, file + suffix), { headers: { 'Content-Type': type } }, error => {
      if (error && !res.headersSent) next()
    })
  }
}

const compressors: Record<Encoding, (input: Buffer, done: (error: Error | null, output: Buffer) => void) => void> = {
  // Quality 4 is fast enough for every request and still much smaller than gzip's default.
  br: (input, done) =>
    zlib.brotliCompress(
      input,
      {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        },
      },
      done,
    ),
  gzip: (input, done) => zlib.gzip(input, { level: 6 }, done),
}

/** Compresses large JSON answers (res.json) for browsers that accept it. Compression runs off the main thread. */
export function compressJson(minBytes = COMPRESS_MIN_BYTES): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const encoding = req.method === 'HEAD' ? '' : pickEncoding(req.headers['accept-encoding'])
    if (!encoding) return next()
    const send = res.json.bind(res)
    res.json = (body?: unknown) => {
      let text: string | undefined
      try {
        text = JSON.stringify(body)
      } catch {
        return send(body)
      }
      if (text === undefined || res.headersSent || Buffer.byteLength(text) < minBytes) return send(body)
      const input = Buffer.from(text)
      compressors[encoding](input, (error, output) => {
        if (res.headersSent || res.writableEnded) return
        if (error) return void send(body)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Encoding', encoding)
        res.setHeader('Content-Length', String(output.length))
        res.vary('Accept-Encoding')
        res.end(output)
      })
      return res
    }
    next()
  }
}
