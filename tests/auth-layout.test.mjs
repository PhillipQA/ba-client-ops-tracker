import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-level CSS contract checks. These do not replace a browser layout test.
const source = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: selectors.split(',').map((selector) => selector.trim()),
  declarations: Object.fromEntries(body.split(';').filter((line) => line.includes(':')).map((line) => {
    const separator = line.indexOf(':')
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  })),
}))
const rulesFor = (selector) => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations)
const firstRule = (selector) => {
  assert.ok(rulesFor(selector).length, `Missing CSS rule: ${selector}`)
  return rulesFor(selector)[0]
}

test('login and recovery both use the shared 470px responsive card width', () => {
  assert.equal(firstRule('.account-login-card').width, 'min(470px, 100%)')
  const login = readFileSync(new URL('../src/app/AuthScreens.tsx', import.meta.url), 'utf8')
  const recovery = readFileSync(new URL('../src/PasswordRecovery.tsx', import.meta.url), 'utf8')
  assert.match(login, /className="auth-card account-login-card auth-card-modern"/)
  assert.match(recovery, /className="auth-card account-login-card"/)
})

test('no login-specific breakpoint overrides the shared width, padding or automatic height', () => {
  for (const rule of rulesFor('.auth-card-modern')) {
    for (const property of ['width', 'max-width', 'height', 'max-height', 'padding', 'padding-inline', 'padding-block']) {
      assert.equal(rule[property], undefined, `Login should share ${property} with recovery`)
    }
  }
  assert.deepEqual(rulesFor('.auth-card').map((rule) => rule.padding), ['28px', '20px'])
  assert.equal(firstRule('.auth-card-modern')['border-radius'], '22px')
  assert.equal(firstRule('.auth-shell-recovery .auth-card')['border-radius'], '22px')
})

test('login uses the recovery form row and label gaps', () => {
  assert.equal(firstRule('.auth-form').gap, '13px')
  assert.equal(firstRule('.auth-form label').gap, '6px')
  assert.ok(rulesFor('.auth-form-modern').every((rule) => rule.gap === undefined))
  assert.ok(rulesFor('.auth-form-modern > label').every((rule) => rule.gap === undefined))
})

test('login fields and submit button match the 42px recovery controls', () => {
  assert.equal(firstRule('.auth-form input')['min-height'], '42px')
  assert.equal(firstRule('.auth-input-shell')['min-height'], '42px')
  // The inner control leaves two pixels for the surrounding one-pixel borders.
  assert.equal(firstRule('.auth-form-modern .auth-input-shell input')['min-height'], '40px')
  assert.equal(firstRule('.auth-submit')['min-height'], '42px')
  assert.equal(firstRule('.auth-submit-modern')['min-height'], '42px')
})

test('the login panel fills its grid track and reserves consistent side gutters', () => {
  assert.equal(firstRule('.auth-login-panel').width, '100%')
  assert.equal(firstRule('.auth-login-panel')['min-width'], '0')
  assert.deepEqual(rulesFor('.auth-login-panel').map((rule) => rule.padding), ['54px 28px 28px', '66px 28px 30px'])
})

test('login options wrap normally without negative-margin overlap on narrow screens', () => {
  assert.equal(firstRule('.auth-form-options')['flex-wrap'], 'wrap')
  assert.ok(rulesFor('.auth-inline-link').every((rule) => !String(rule['margin-top'] || '').startsWith('-')))
})
