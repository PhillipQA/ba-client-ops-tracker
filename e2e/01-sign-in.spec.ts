/** Workspace sign-in: the account step, a wrong password, the right one, and signing out. */
import { expect, test } from '@playwright/test'
import { ACCOUNT, heading, PASSWORD, shot, skipTour, USER } from './support/app'

test('sign in to the workspace in two steps, and sign out', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByText('Which account are you signing in to?')).toBeVisible()
  await shot(page, testInfo, '01-account-step')

  await page.getByLabel('Account').fill(ACCOUNT)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText(`Signing in to ${ACCOUNT}`)).toBeVisible()
  await page.getByLabel('User', { exact: true }).fill(USER)
  await page.getByLabel('Password', { exact: true }).fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await shot(page, testInfo, '02-wrong-password')

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(heading(page, 'My Action Center')).toBeVisible()
  await skipTour(page)
  await shot(page, testInfo, '03-action-center')

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByText('Which account are you signing in to?')).toBeVisible()
})
