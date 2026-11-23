/** Every main page opens (each downloads when first opened) without the error screen. */
import { test } from '@playwright/test'
import { ADMIN_STATE, open, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

const PAGES: [string, string, string][] = [
  ['/work-hub', 'Work Hub', '01-work-hub'],
  ['/requirements', 'Requirements & Traceability', '02-requirements'],
  ['/documents', 'Document Creation', '03-documents'],
  ['/reports', 'Reports', '04-reports'],
  ['/themes', 'My Themes', '05-themes'],
]

for (const [address, title, name] of PAGES)
  test(`${title} opens`, async ({ page }, testInfo) => {
    await open(page, address, title)
    await shot(page, testInfo, name)
  })
