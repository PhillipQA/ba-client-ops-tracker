/** Signs in once as the workspace Administrator and keeps the session for the other tests. */
import { expect, test as setup } from '@playwright/test'
import { ADMIN_STATE, heading, signIn, skipTour } from './support/app'

setup('sign in as the workspace Administrator', async ({ page }) => {
  await signIn(page)
  await expect(heading(page, 'My Action Center')).toBeVisible()
  await skipTour(page)
  await page.context().storageState({ path: ADMIN_STATE })
})
