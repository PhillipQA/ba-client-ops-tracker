/** The Tasks board: the same tasks as cards, grouped by status. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, createClient, createTask, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('switch Tasks to the board and back', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client, status: 'In Progress' })

  await page.getByRole('button', { name: 'Board' }).click()
  const card = page.getByRole('button', { name: title }).first()
  await expect(card).toBeVisible()
  await shot(page, testInfo, '01-board')

  await page.getByRole('button', { name: 'Table' }).click()
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible()
})
