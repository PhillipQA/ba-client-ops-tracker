import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { registerStaticSite } from '../server/platform/static-site'

let dist = ''
let server: Server
let base = ''

before(async () => {
  dist = mkdtempSync(path.join(tmpdir(), 'static-site-'))
  mkdirSync(path.join(dist, 'assets'))
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="/assets/index-NEW.js"></script>')
  writeFileSync(path.join(dist, 'assets', 'index-NEW.js'), 'console.log(1)')
  writeFileSync(path.join(dist, 'favicon.ico'), 'x')
  const app = express()
  registerStaticSite(app, dist)
  server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)) })
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => { server?.close(); rmSync(dist, { recursive: true, force: true }) })

test('index.html is revalidated on every load', async () => {
  for (const url of ['/', '/tasks/123', '/index.html']) {
    const res = await fetch(base + url)
    assert.equal(res.status, 200, url)
    assert.match(res.headers.get('content-type') || '', /text\/html/, url)
    assert.equal(res.headers.get('cache-control'), 'no-cache', url)
  }
})

test('hashed assets are cached long-term', async () => {
  const res = await fetch(base + '/assets/index-NEW.js')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') || '', /javascript/)
  assert.match(res.headers.get('cache-control') || '', /max-age=31536000.*immutable/)
})

test('a missing asset from an old build is a 404, not index.html', async () => {
  for (const url of ['/assets/index-OLD.js', '/assets/index-OLD.css']) {
    const res = await fetch(base + url)
    assert.equal(res.status, 404, url)
    assert.doesNotMatch(res.headers.get('content-type') || '', /text\/html/, url)
    assert.equal(res.headers.get('cache-control'), 'no-store', url)
  }
})

test('other public files are still served', async () => {
  const res = await fetch(base + '/favicon.ico')
  assert.equal(res.status, 200)
})
