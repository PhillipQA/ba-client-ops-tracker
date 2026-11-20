import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Google is set up once per page; its answer goes to the Google button on screen now', async () => {
  const initialized: any[] = []
  ;(globalThis as any).window = {
    google: { accounts: { id: { initialize: (config: any) => initialized.push(config) } } },
  }
  const { googleWithHandler, releaseGoogleHandler } = await import('../src/shared/googleIdentity')
  const got: string[] = []
  const first = (credential: string) => got.push(`first:${credential}`)
  const second = (credential: string) => got.push(`second:${credential}`)
  await googleWithHandler('client-a', first)
  // Failed sign-in, Change account, Continue: the button is made again.
  releaseGoogleHandler(first)
  await googleWithHandler('client-a', second)
  assert.equal(initialized.length, 1, 'not set up a second time')
  initialized[0].callback({ credential: 'token-1' })
  assert.deepEqual(got, ['second:token-1'])
  releaseGoogleHandler(first)
  initialized[0].callback({ credential: 'token-2' })
  assert.deepEqual(got, ['second:token-1', 'second:token-2'], 'an old button cannot take it back')
  releaseGoogleHandler(second)
  initialized[0].callback({ credential: 'token-3' })
  assert.equal(got.length, 2, 'no button on screen: the answer is dropped')
  await googleWithHandler('client-b', second)
  assert.equal(initialized.length, 2, 'a different Google client is set up once too')
  delete (globalThis as any).window
})

test('the login and Seeds use the shared set-up; Change clears the last account’s error', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  for (const path of ['src/app/AuthScreens.tsx', 'src/features/seeds/SendToSeeds.tsx'])
    assert.doesNotMatch(read(path), /accounts\.id\.initialize\(/, `${path} sets Google up only through googleIdentity`)
  const screens = read('src/app/AuthScreens.tsx')
  assert.match(screens, /releaseGoogleHandler\(onCredential\)/)
  assert.match(screens, /setChosen\(''\)\n\s*onClearError\?\.\(\)/)
  assert.match(read('src/app/App.tsx'), /onClearError=\{\(\) => setLoginError\(''\)\}/)
})
