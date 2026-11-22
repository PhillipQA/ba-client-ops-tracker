import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { compressJson, pickEncoding, precompressedAssets } from '../server/platform/compression'
import { storedWorkspaceVersion, workspaceVersion } from '../server/services/workspace-version'
import { businessDateKey, msUntilNextBusinessDay, setBusinessTimeZone } from '../src/shared/businessDate'
import { dateFormat } from '../src/shared/intlFormat'

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('pages download when first opened; the Action Center comes with the app', () => {
  const app = read('src/app/App.tsx')
  for (const page of [
    'RequirementsTraceability',
    'Trackers',
    'DocumentCreation',
    'InternalAdmin',
    'CustomReports',
    'Settings',
    'AccountUsers',
    'ThemePreferences',
    'SeedsSyncPage',
    'SeedsTabs',
    'ClientsPage',
    'ProjectsPage',
    'InboxPage',
    'TasksPage',
    'AiPage',
  ]) {
    assert.match(app, new RegExp(`const ${page} = lazyPage\\(`), page)
    assert.doesNotMatch(app, new RegExp(`^import (\\{[^}]*\\b${page}\\b[^}]*\\}|${page}) from`, 'm'), page)
  }
  assert.match(app, /import \{ ActionCenterPage \} from '\.\.\/features\/action-center\/ActionCenterPage'/)
  assert.match(app, /<Suspense fallback=\{<PageLoading \/>\}>/)
  assert.match(app, /onPointerEnter=\{\(\) => preloadPage\(id\)\}/)
  // Documents: mounted once opened (it keeps drafts), holding its lists while hidden.
  assert.match(app, /hasModule\('documents'\) && documentsSeen\.current &&/)
  assert.match(app, /items=\{documentInputs\.items\}/)
  assert.match(app, /memo\(module\.default\)/)
})

test('the Action Center loads widget editors and Jarvis when opened; settingsRequest has its own file', () => {
  const reports = read('src/features/action-center/ActionCenterReports.tsx')
  assert.match(reports, /const WidgetEditor = lazy\(/)
  assert.match(reports, /const QueryWidgetEditor = lazy\(/)
  assert.doesNotMatch(reports, /^import \{ (WidgetEditor|QueryWidgetEditor) \}/m)
  const page = read('src/features/action-center/ActionCenterPage.tsx')
  assert.match(page, /const JarvisReportDialog = lazy\(/)
  assert.doesNotMatch(page, /^import \{ JarvisReportDialog \}/m)
  for (const file of [
    'src/app/state/useAccountAndRoutes.ts',
    'src/features/admin/PlatformAiAgents.tsx',
    'src/features/settings/PlatformSettings.tsx',
    'src/features/accounts/AccountUsers.tsx',
  ])
    assert.match(
      read(file),
      /import \{ settingsRequest \} from '[./]+(features\/)?settings\/settingsRequest'|from '\.\/settingsRequest'/,
      file,
    )
})

test('a page from an old build reloads once to get the new build, then shows the error', async () => {
  const store = new Map<string, string>()
  ;(globalThis as any).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
  const { recoverFromStaleBuild } = await import('../src/app/lazyPage')
  let reloads = 0
  const pending = recoverFromStaleBuild(new Error('chunk gone'), () => reloads++)
  assert.equal(reloads, 1)
  assert.equal(store.get('ba-chunk-reloaded'), '1')
  void pending
  await assert.rejects(
    recoverFromStaleBuild(new Error('still gone'), () => reloads++),
    /still gone/,
  )
  assert.equal(reloads, 1, 'a second failure in a row does not reload again')
  assert.equal(store.has('ba-chunk-reloaded'), false)
  delete (globalThis as any).sessionStorage
})

test('encodings: Brotli, then gzip; q=0 refuses one', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br')
  assert.equal(pickEncoding('gzip, deflate'), 'gzip')
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip')
  assert.equal(pickEncoding('identity'), '')
  assert.equal(pickEncoding(undefined), '')
  assert.equal(pickEncoding('*'), 'gzip')
})

/** A stand-in for Express's request and response: enough for compressJson. */
function exchange(method: string, acceptEncoding: string) {
  const headers: Record<string, string> = {}
  const result: { body?: Buffer; json?: unknown; done: Promise<void> } = {} as any
  let finish = () => {}
  result.done = new Promise(resolve => {
    finish = resolve
  })
  const res: any = {
    headersSent: false,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value
    },
    vary: (field: string) => {
      headers.vary = field
    },
    end: (body: Buffer) => {
      result.body = body
      res.headersSent = true
      finish()
    },
    json: (body: unknown) => {
      result.json = body
      res.headersSent = true
      finish()
      return res
    },
  }
  const req: any = { method, headers: { 'accept-encoding': acceptEncoding } }
  return { req, res, headers, result }
}

test('large JSON answers are compressed for browsers that accept it; small ones and HEAD are not', async () => {
  const big = { items: Array.from({ length: 800 }, (_, i) => ({ id: i, title: `Task number ${i}` })) }
  for (const [accept, decode] of [
    ['gzip, deflate, br', zlib.brotliDecompressSync],
    ['gzip', zlib.gunzipSync],
  ] as const) {
    const { req, res, headers, result } = exchange('GET', accept)
    compressJson()(req, res, () => {})
    res.json(big)
    await result.done
    assert.equal(headers['content-encoding'], accept === 'gzip' ? 'gzip' : 'br')
    assert.equal(headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(headers.vary, 'Accept-Encoding')
    assert.deepEqual(JSON.parse(decode(result.body!).toString()), big)
    assert.ok(result.body!.length < JSON.stringify(big).length / 3, 'much smaller')
  }
  for (const [method, accept, body] of [
    ['GET', 'br', { ok: true }],
    ['HEAD', 'br', big],
    ['GET', 'identity', big],
  ] as const) {
    const { req, res, headers, result } = exchange(method, accept)
    compressJson()(req, res, () => {})
    res.json(body)
    await result.done
    assert.deepEqual(result.json, body, `${method} ${accept}`)
    assert.equal(headers['content-encoding'], undefined)
  }
})

test('built files: compress-dist writes .br and .gz copies; the server sends the one the browser accepts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'compress-dist-'))
  try {
    const script = 'console.log("a fairly repetitive line of built JavaScript");\n'.repeat(200)
    writeFileSync(path.join(dir, 'index-ABC.js'), script)
    writeFileSync(path.join(dir, 'tiny-ABC.js'), 'x')
    writeFileSync(path.join(dir, 'logo.png'), 'not text')
    execFileSync(process.execPath, [new URL('../scripts/compress-dist.mjs', import.meta.url).pathname, dir])
    assert.equal(zlib.brotliDecompressSync(readFileSync(path.join(dir, 'index-ABC.js.br'))).toString(), script)
    assert.equal(zlib.gunzipSync(readFileSync(path.join(dir, 'index-ABC.js.gz'))).toString(), script)
    assert.equal(existsSync(path.join(dir, 'tiny-ABC.js.br')), false, 'under 1 KB')
    assert.equal(existsSync(path.join(dir, 'logo.png.br')), false, 'not a text file')

    const serve = precompressedAssets(dir)
    const sent: { file?: string; headers: Record<string, string>; next: boolean } = { headers: {}, next: false }
    const res: any = {
      headersSent: false,
      setHeader: (name: string, value: string) => {
        sent.headers[name.toLowerCase()] = value
      },
      sendFile: (file: string) => {
        sent.file = file
      },
    }
    serve({ method: 'GET', path: '/index-ABC.js', headers: { 'accept-encoding': 'gzip, br' } } as any, res, () => {
      sent.next = true
    })
    assert.equal(sent.file, path.join(dir, 'index-ABC.js.br'))
    assert.equal(sent.headers['content-encoding'], 'br')
    assert.match(sent.headers['content-type'], /javascript/)
    assert.match(sent.headers['cache-control'], /immutable/)
    let passed = 0
    for (const [file, accept] of [
      ['/tiny-ABC.js', 'br'],
      ['/index-ABC.js', 'identity'],
      ['/logo.png', 'br'],
      ['/../secret.js', 'br'],
    ])
      serve({ method: 'GET', path: file, headers: { 'accept-encoding': accept } } as any, res, () => passed++)
    assert.equal(passed, 4, 'no copy, not accepted, not text, or outside: served as before')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('date formatters are made once and give the same text', () => {
  const options = { month: 'short', day: 'numeric', year: 'numeric' } as const
  assert.equal(dateFormat('en', options), dateFormat('en', { ...options }))
  assert.notEqual(dateFormat('en', options), dateFormat('en', { month: 'short' }))
  const date = new Date(2026, 10, 22)
  assert.equal(dateFormat('en', options).format(date), date.toLocaleDateString('en', options))
})

test('the business date is checked at midnight, not every second', () => {
  setBusinessTimeZone('Asia/Manila')
  // 23:59:30 in Manila (UTC+8) is 15:59:30 UTC.
  const late = msUntilNextBusinessDay(new Date('2026-11-22T15:59:30.000Z'))
  assert.ok(late >= 30_000 && late <= 31_000, String(late))
  const early = msUntilNextBusinessDay(new Date('2026-11-21T16:00:00.000Z'))
  assert.ok(early > 86_000_000, String(early))
  assert.equal(businessDateKey(new Date('2026-11-22T16:00:01.000Z')), '2026-11-23')
  const hook = read('src/shared/businessDate.ts')
  assert.doesNotMatch(hook, /setInterval\(update, 1000\)/)
  assert.match(hook, /setTimeout\(update, Math\.min\(msUntilNextBusinessDay\(\), RECHECK_MS\)\)/)
})

test('the workspace version is hashed once per stored revision', () => {
  const state = {
    clients: [{ id: 'c1', name: 'A' }],
    projects: [],
    planner: [],
    rtms: [],
    items: [{ id: 't1', title: 'One' }],
  }
  const first = storedWorkspaceVersion('tenant-perf', '2026-11-22T10:00:00Z', state)
  assert.equal(first, workspaceVersion(state))
  // Same updated_at means the same stored data: the remembered version is used without hashing again.
  const changed = { ...state, items: [{ id: 't1', title: 'Two' }] }
  assert.equal(storedWorkspaceVersion('tenant-perf', '2026-11-22T10:00:00Z', changed), first)
  // A new updated_at (every save sets one) is hashed.
  assert.equal(storedWorkspaceVersion('tenant-perf', '2026-11-22T10:05:00Z', changed), workspaceVersion(changed))
  // Without updated_at nothing is remembered.
  assert.equal(storedWorkspaceVersion('tenant-perf', undefined, state), workspaceVersion(state))
  const routes = read('server/workspace/store-routes.ts')
  assert.match(
    routes,
    /version: storedWorkspaceVersion\(String\(tenantIdForUser\(user\)\), state\.updatedAt, state\.data\)/,
  )
  assert.match(routes, /storedWorkspaceVersion\(String\(organizationId\), currentState\.updatedAt, current\)/)
})

test('compression is wired into the server and the build', () => {
  assert.match(read('server/index.ts'), /app\.use\('\/api', compressJson\(\)\)/)
  assert.match(
    read('server/platform/static-site.ts'),
    /app\.use\('\/assets', precompressedAssets\(path\.join\(dist, 'assets'\)\)\)/,
  )
  assert.match(read('package.json'), /"build": "tsc -b && vite build && node scripts\/compress-dist\.mjs"/)
})
