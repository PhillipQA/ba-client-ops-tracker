/** Settings › Workflow: add a task status, and it is offered in the task form. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, dialog, open, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('add a task status in Settings › Workflow', async ({ page }, testInfo) => {
  const status = `Review ${Date.now().toString(36).slice(-4)}`
  await open(page, '/settings', 'Settings')
  await page.getByRole('tab', { name: 'Workflow' }).click()
  await page.getByLabel('New task status').fill(status)
  await page.getByRole('button', { name: 'Add status' }).click()
  await shot(page, testInfo, '01-workflow')
  await page.getByRole('button', { name: 'Save workflow' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Workflow saved' })).toBeVisible()

  // The new status reaches the task form after the workspace reloads.
  await page.reload()
  await open(page, '/tasks', 'Tasks')
  await page.getByRole('button', { name: 'New task' }).click()
  const form = dialog(page, 'Add task')
  await expect(form.getByLabel('Status', { exact: true }).locator('option', { hasText: status })).toHaveCount(1)
  await shot(page, testInfo, '02-status-in-task-form')
  await form.getByRole('button', { name: 'Close' }).click()
})
