// After `vite build`: a Brotli (.br) and a gzip (.gz) copy of each built JS, CSS, SVG and JSON file in dist/assets,
// so the server can send the smallest one the browser accepts (server/platform/compression.ts). Files under 1 KB,
// and copies that would not be smaller, are skipped. Uses Node's own zlib.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const root = path.resolve(process.argv[2] || 'dist/assets')
const wanted = /\.(m?js|css|svg|json)$/
let files = 0
let before = 0
let after = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (wanted.test(name)) compress(full)
  }
}

function compress(file) {
  const input = readFileSync(file)
  if (input.length < 1024) return
  const br = zlib.brotliCompressSync(input, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
    },
  })
  const gz = zlib.gzipSync(input, { level: 9 })
  if (br.length < input.length) writeFileSync(`${file}.br`, br)
  if (gz.length < input.length) writeFileSync(`${file}.gz`, gz)
  files++
  before += input.length
  after += Math.min(br.length, input.length)
}

try {
  walk(root)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const kb = bytes => `${Math.round(bytes / 1024)} KB`
console.log(`compress-dist: ${files} files, ${kb(before)} -> ${kb(after)} with Brotli`)
