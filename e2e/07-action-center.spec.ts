/** Action Center: a task due today is counted, and clicking the count lists it. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, businessToday, createClient, createTask, dialog, open, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('the Due today tile counts a task due today and lists it when clicked', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client, dueDate: businessToday() })

  await open(page, '/', 'My Action Center')
  const tile = page.getByRole('button', { name: /Due today/ }).first()
  await expect(tile).toBeVisible()
  await shot(page, testInfo, '01-action-center')

  await tile.click()
  const list = dialog(page, /Due today/)
  await expect(list).toBeVisible()
  await expect(list.getByRole('row').filter({ hasText: title })).toBeVisible()
  await shot(page, testInfo, '02-due-today-list')
  await list.getByRole('button', { name: 'Close' }).click()
  await expect(list).toBeHidden()
})
