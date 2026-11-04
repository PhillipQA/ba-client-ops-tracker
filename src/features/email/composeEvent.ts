// Opening the email composer from anywhere: an event the composer listens for. No UI or styles here, so callers
// (and tests) can use it without loading the composer.
import type { DriveRef, Upload } from './emailOutbox'

export type ComposePrefill = {
  taskIds?: string[]
  to?: string
  cc?: string
  bcc?: string
  subject?: string
  message?: string
  driveFiles?: DriveRef[]
  uploads?: Upload[]
  replyToId?: string
  /** A reply that copied the other people on the original email, so the composer can say so and offer to remove them. */
  autoCc?: boolean
  /** A short message shown above the form, for example when part of the prefill could not be filled in. */
  notice?: string
  /** An email taken back with Undo: closing it asks first, because it would otherwise be lost. */
  restored?: boolean
}
export const COMPOSE_EVENT = 'email-compose'
export function composeEmail(prefill: ComposePrefill = {}) {
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: prefill }))
}
