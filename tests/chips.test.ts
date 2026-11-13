import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InquirySourceBadge } from '../src/shared/ui/Chips'

test('an inquiry without a source shows Other instead of stopping the page', () => {
  assert.match(
    renderToStaticMarkup(createElement(InquirySourceBadge, { source: undefined as any })),
    /source-other.*>Other</,
  )
  assert.match(
    renderToStaticMarkup(createElement(InquirySourceBadge, { source: 'Email', isNew: true })),
    /source-email is-new.*>Email · New</,
  )
})
