/** Users & Permissions: add a Contributor. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, open, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('add a Contributor user', async ({ page }, testInfo) => {
  const username = `e2e.${Date.now().toString(36).slice(-6)}`
  await open(page, '/users', 'Users & Permissions')
  await shot(page, testInfo, '01-users')

  await page.getByRole('button', { name: 'Add user' }).click()
  const form = page.locator('form.account-user-form')
  await form.getByLabel('Name', { exact: true }).fill('E2E Contributor')
  await form.getByLabel('Username').fill(username)
  await form.getByLabel('Email').fill(`${username}@example.com`)
  await form.getByLabel('Initial password').fill('E2e-Initial-Password-1')
  await form.getByLabel('Role').selectOption('Contributor')
  await shot(page, testInfo, '02-add-user')
  await form.getByRole('button', { name: 'Save user' }).click()
  await expect(form).toBeHidden()
  await expect(page.getByRole('row').filter({ hasText: username })).toBeVisible()
  await shot(page, testInfo, '03-user-added')
})
