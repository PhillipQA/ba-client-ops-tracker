/** Trackers: make a blank tracker, add a row, and type into its first cell. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, dialog, open, shot, unique } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('create a tracker and add a row', async ({ page }, testInfo) => {
  const name = unique('E2E Tracker')
  await open(page, '/trackers', 'Trackers')
  await shot(page, testInfo, '01-trackers')

  await page.getByRole('button', { name: 'New tracker' }).first().click()
  const form = dialog(page, 'New tracker')
  await form.getByLabel('Name', { exact: true }).fill(name)
  await shot(page, testInfo, '02-new-tracker')
  await form.getByRole('button', { name: 'Create tracker' }).click()
  await expect(form).toBeHidden()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(name)

  await page.getByRole('button', { name: 'Add row' }).first().click()
  // A new row opens its first cell for typing.
  await expect(page.locator('input.trk-input:focus')).toHaveCount(1)
  await page.keyboard.type('First row from the E2E tests')
  await page.keyboard.press('Enter')
  await expect(page.getByText('First row from the E2E tests')).toBeVisible()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /Saved|All changes saved/ })
      .first(),
  ).toBeVisible()
  await shot(page, testInfo, '03-row-added')
})
