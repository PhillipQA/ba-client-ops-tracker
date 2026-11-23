/**
 * Internal Admin signs in only at /internal_admin. Its first sign-in asks for a new password; later runs (or a
 * second run on the same database) sign in with that new password instead.
 */
import { expect, test } from '@playwright/test'
import { shot } from './support/app'

const BOOTSTRAP = process.env.INTERNAL_ADMIN_BOOTSTRAP_PASSWORD || ''
const CHANGED = process.env.E2E_INTERNAL_ADMIN_NEW_PASSWORD || `${BOOTSTRAP}-changed`

test.skip(!BOOTSTRAP, 'Set INTERNAL_ADMIN_BOOTSTRAP_PASSWORD to test Internal Admin.')

test('Internal Admin signs in at /internal_admin and sees the accounts', async ({ page }, testInfo) => {
  const signIn = async (password: string) => {
    await page.goto('/internal_admin')
    await page.getByLabel('User', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }
  await page.goto('/internal_admin')
  await shot(page, testInfo, '01-internal-admin-sign-in')

  await signIn(BOOTSTRAP)
  const security = page.getByRole('heading', { name: 'Internal Admin security' })
  const failed = page.getByRole('alert')
  await expect(security.or(failed).first()).toBeVisible()
  if (await failed.isVisible()) {
    // The bootstrap password was already replaced by an earlier run.
    await signIn(CHANGED)
  } else {
    await shot(page, testInfo, '02-choose-new-password')
    await page.getByLabel('Current password').fill(BOOTSTRAP)
    await page.getByLabel('New password', { exact: true }).fill(CHANGED)
    await page.getByLabel('Confirm new password').fill(CHANGED)
    await page.getByRole('button', { name: 'Change password' }).click()
    await expect(security).toBeHidden()
  }
  await expect(page.getByText('BXI-Core').first()).toBeVisible()
  await shot(page, testInfo, '03-internal-admin-accounts')
})
