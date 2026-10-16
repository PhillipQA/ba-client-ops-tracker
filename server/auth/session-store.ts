import { randomBytes } from 'node:crypto'

/** Absolute session lifetime. The browser cookie uses the same value, so both expire together. */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000
/** A session unused for this long is ended even if its cookie is still valid. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000

type Entry<T> = { user: T; createdAt: number; lastSeenAt: number }

export type SessionStoreOptions = {
  maxAgeMs?: number
  idleTimeoutMs?: number
  now?: () => number
}

function positive(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Reads SESSION_IDLE_TIMEOUT_MINUTES; anything missing or invalid falls back to the default. */
export function idleTimeoutFromEnv(value: string | undefined) {
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_SESSION_IDLE_TIMEOUT_MS
}

/**
 * In-memory sessions with server-enforced expiry. The browser's cookie Max-Age is only a hint:
 * a copied token must stop working on the server once it is too old or has sat idle.
 * It mirrors the small part of the Map API the server already uses (set, delete, entries).
 */
export class SessionStore<T> {
  private readonly entries_ = new Map<string, Entry<T>>()
  private readonly maxAgeMs: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number

  constructor(options: SessionStoreOptions = {}) {
    this.maxAgeMs = positive(options.maxAgeMs, SESSION_MAX_AGE_MS)
    this.idleTimeoutMs = positive(options.idleTimeoutMs, DEFAULT_SESSION_IDLE_TIMEOUT_MS)
    this.now = options.now ?? Date.now
  }

  private expired(entry: Entry<T>, at: number) {
    return at - entry.createdAt >= this.maxAgeMs || at - entry.lastSeenAt >= this.idleTimeoutMs
  }

  /** Starts a session for a freshly authenticated user and returns its new random token. */
  create(user: T) {
    const token = randomBytes(32).toString('hex')
    const at = this.now()
    this.entries_.set(token, { user, createdAt: at, lastSeenAt: at })
    return token
  }

  /** Returns the user for a live token and counts the request as activity; expired tokens are removed. */
  get(token: string): T | null {
    const entry = this.entries_.get(token)
    if (!entry) return null
    const at = this.now()
    if (this.expired(entry, at)) {
      this.entries_.delete(token)
      return null
    }
    entry.lastSeenAt = at
    return entry.user
  }

  /** Replaces the stored user without extending the session's life. Unknown tokens start a new session. */
  set(token: string, user: T) {
    const entry = this.entries_.get(token)
    if (entry) entry.user = user
    else {
      const at = this.now()
      this.entries_.set(token, { user, createdAt: at, lastSeenAt: at })
    }
    return this
  }

  delete(token: string) {
    return this.entries_.delete(token)
  }

  /** Live sessions only. Safe to delete or set while iterating. */
  *entries(): IterableIterator<[string, T]> {
    const at = this.now()
    for (const [token, entry] of this.entries_) {
      if (this.expired(entry, at)) {
        this.entries_.delete(token)
        continue
      }
      yield [token, entry.user]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  /** Drops expired sessions that nobody has presented again, so abandoned tokens do not pile up. */
  prune() {
    const at = this.now()
    let removed = 0
    for (const [token, entry] of this.entries_) {
      if (this.expired(entry, at)) {
        this.entries_.delete(token)
        removed += 1
      }
    }
    return removed
  }

  get size() {
    return this.entries_.size
  }
}
