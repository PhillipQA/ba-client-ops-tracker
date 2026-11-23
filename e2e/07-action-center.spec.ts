/**
 * Action Center: a task due today is in the Morning brief, and clicking the Needs attention count lists the work
 * behind it.
 */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, businessToday, createClient, createTask, dialog, open, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('a task due today is in the brief, and the Needs attention count lists it', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client, dueDate: businessToday() })

  await open(page, '/', 'My Action Center')
  await expect(page.getByRole('region', { name: 'Due today' })).toContainText(title)
  const tile = page.getByRole('button', { name: /^Needs attention/ })
  await expect(tile).toBeVisible()
  await shot(page, testInfo, '01-action-center')

  await tile.click()
  const list = dialog(page, /Needs attention/)
  await expect(list).toBeVisible()
  await expect(list.getByRole('row').filter({ hasText: title })).toBeVisible()
  await shot(page, testInfo, '02-needs-attention-list')
  await list.getByRole('button', { name: 'Close' }).click()
  await expect(list).toBeHidden()
})
