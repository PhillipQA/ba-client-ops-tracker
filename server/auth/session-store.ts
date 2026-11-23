import { createHash, randomBytes } from 'node:crypto'

/** Absolute session lifetime. The browser cookie uses the same value, so both expire together. */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000
/** A session unused for this long is ended even if its cookie is still valid. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000

/** What is kept of a session between restarts (see SessionPersistence). */
export type StoredSession<T> = { user: T; createdAt: number; lastSeenAt: number; flags: Record<string, boolean> }

/**
 * Where sessions are kept so they outlive a restart and are shared between servers (auth/session-database.ts). Rows
 * are keyed by `sessionKey(token)`, a SHA-256 of the token: the token itself is never stored, so a copy of the table
 * cannot be used to sign in.
 */
export interface SessionPersistence<T> {
  save(key: string, session: StoredSession<T>, expiresAt: number): Promise<void>
  touch(key: string, lastSeenAt: number, expiresAt: number): Promise<void>
  remove(key: string): Promise<void>
  /** The stored session, null when there is none; throws when the store cannot be read. */
  load(key: string): Promise<StoredSession<T> | null>
  /** Every session that has not expired by `now`. */
  loadAll(now: number): Promise<[string, StoredSession<T>][]>
  prune(now: number): Promise<void>
}

type Entry<T> = StoredSession<T> & {
  /** The token, when this server has seen it (it made the session or it was presented); restored sessions lack it. */
  token?: string
  /** For a restored session without its token: the random stand-in entries() yields for it (see keyOf). */
  handle?: string
  /** When the stored copy was last read or written by this server. */
  checkedAt: number
  /** Whether the stored copy is known to exist. */
  persisted: boolean
  /** The lastSeenAt last written to the store. */
  storedSeenAt: number
}

export type SessionStoreOptions<T = unknown> = {
  maxAgeMs?: number
  idleTimeoutMs?: number
  now?: () => number
  persistence?: SessionPersistence<T>
  /** How long a session read from the store is trusted before it is read again (sign-outs elsewhere). */
  recheckMs?: number
  /** Activity is written to the store at most this often per session. */
  touchEveryMs?: number
  /** Called when a session comes in from the store (after a restart, or made by another server). */
  onRestore?: (key: string, session: StoredSession<T>) => void
  onError?: (error: unknown) => void
}

function positive(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Reads SESSION_IDLE_TIMEOUT_MINUTES; anything missing or invalid falls back to the default. */
export function idleTimeoutFromEnv(value: string | undefined) {
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_SESSION_IDLE_TIMEOUT_MS
}

/** The key a session is stored under: a SHA-256 of its token. */
export function sessionKey(token: string) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Sessions with server-enforced expiry. The browser's cookie Max-Age is only a hint: a copied token must stop working
 * on the server once it is too old or has sat idle. It mirrors the small part of the Map API the server already uses
 * (set, delete, entries).
 *
 * With a `persistence`, the sessions in memory are a cache of the stored ones: every change is written through (in
 * order, per session), `ready(token)` reads a session this server does not hold (or has not checked for a while)
 * before a request is handled, and `restore()` loads them all after a restart. A token is looked up only by its
 * hash: presenting a stored key as a cookie does not sign anyone in.
 */
export class SessionStore<T> {
  private readonly entries_ = new Map<string, Entry<T>>()
  private readonly maxAgeMs: number
  private readonly idleTimeoutMs: number
  private readonly now: () => number
  private readonly persistence?: SessionPersistence<T>
  private readonly recheckMs: number
  private readonly touchEveryMs: number
  private readonly onRestore?: (key: string, session: StoredSession<T>) => void
  private readonly onError: (error: unknown) => void
  private readonly writes = new Map<string, Promise<void>>()
  private readonly reads = new Map<string, Promise<void>>()
  private readonly handles = new Map<string, string>()

  constructor(options: SessionStoreOptions<T> = {}) {
    this.maxAgeMs = positive(options.maxAgeMs, SESSION_MAX_AGE_MS)
    this.idleTimeoutMs = positive(options.idleTimeoutMs, DEFAULT_SESSION_IDLE_TIMEOUT_MS)
    this.now = options.now ?? Date.now
    this.persistence = options.persistence
    this.recheckMs = positive(options.recheckMs, 60_000)
    this.touchEveryMs = positive(options.touchEveryMs, 60_000)
    this.onRestore = options.onRestore
    this.onError = options.onError ?? (error => console.error('Session store:', (error as Error)?.message || error))
  }

  private expired(entry: StoredSession<T>, at: number) {
    return at - entry.createdAt >= this.maxAgeMs || at - entry.lastSeenAt >= this.idleTimeoutMs
  }

  private expiresAt(entry: StoredSession<T>) {
    return Math.min(entry.createdAt + this.maxAgeMs, entry.lastSeenAt + this.idleTimeoutMs)
  }

  /**
   * A token's key. entries() yields a random stand-in for a restored session whose token this server has not seen;
   * it is known only inside this process, so a cookie can never name a session by it (nor by its stored key).
   */
  private keyOf(tokenOrHandle: string) {
    return this.handles.get(tokenOrHandle) ?? sessionKey(tokenOrHandle)
  }

  private handleOf(key: string, entry: Entry<T>) {
    if (!entry.handle) {
      entry.handle = `restored:${randomBytes(24).toString('hex')}`
      this.handles.set(entry.handle, key)
    }
    return entry.handle
  }

  private drop(key: string) {
    const entry = this.entries_.get(key)
    if (entry?.handle) this.handles.delete(entry.handle)
    return this.entries_.delete(key)
  }

  /** Runs store writes for one session one after another, so a sign-out can never land before its sign-in. */
  private write(key: string, run: (persistence: SessionPersistence<T>) => Promise<void>) {
    const persistence = this.persistence
    if (!persistence) return Promise.resolve()
    const next = (this.writes.get(key) || Promise.resolve()).then(() => run(persistence))
    const settled = next.catch(error => {
      this.onError(error)
      throw error
    })
    const tail = settled.catch(() => undefined)
    this.writes.set(key, tail)
    void tail.then(() => {
      if (this.writes.get(key) === tail) this.writes.delete(key)
    })
    return settled
  }

  private persist(key: string, entry: Entry<T>) {
    const { user, createdAt, lastSeenAt, flags } = entry
    entry.storedSeenAt = lastSeenAt
    void this.write(key, persistence =>
      persistence.save(key, { user, createdAt, lastSeenAt, flags }, this.expiresAt(entry)),
    )
      .then(() => {
        entry.persisted = true
        entry.checkedAt = this.now()
      })
      .catch(() => {
        entry.persisted = false
      })
  }

  private forget(key: string) {
    const existed = this.drop(key)
    void this.write(key, persistence => persistence.remove(key)).catch(() => undefined)
    return existed
  }

  /** Starts a session for a freshly authenticated user and returns its new random token. */
  create(user: T, flags: Record<string, boolean> = {}) {
    const token = randomBytes(32).toString('hex')
    const at = this.now()
    const entry: Entry<T> = {
      user,
      createdAt: at,
      lastSeenAt: at,
      flags: { ...flags },
      token,
      checkedAt: at,
      persisted: false,
      storedSeenAt: at,
    }
    this.entries_.set(sessionKey(token), entry)
    this.persist(sessionKey(token), entry)
    return token
  }

  /** Returns the user for a live token and counts the request as activity; expired tokens are removed. */
  get(token: string): T | null {
    if (!token) return null
    const key = sessionKey(token)
    const entry = this.entries_.get(key)
    if (!entry) return null
    const at = this.now()
    if (this.expired(entry, at)) {
      this.forget(key)
      return null
    }
    entry.token = token
    entry.lastSeenAt = at
    if (entry.persisted && at - entry.storedSeenAt >= this.touchEveryMs) {
      entry.storedSeenAt = at
      void this.write(key, persistence => persistence.touch(key, at, this.expiresAt(entry))).catch(() => undefined)
    }
    return entry.user
  }

  /** The flags a session was started or marked with (for example a Seeds exception). */
  flags(tokenOrKey: string): Record<string, boolean> {
    return { ...(this.entries_.get(this.keyOf(tokenOrKey))?.flags || {}) }
  }

  /** Marks a live session; the mark is stored with it. */
  setFlag(tokenOrKey: string, flag: string, value: boolean) {
    const key = this.keyOf(tokenOrKey)
    const entry = this.entries_.get(key)
    if (!entry || Boolean(entry.flags[flag]) === value) return
    entry.flags = { ...entry.flags, [flag]: value }
    this.persist(key, entry)
  }

  /** Replaces the stored user without extending the session's life. Unknown tokens start a new session. */
  set(tokenOrKey: string, user: T) {
    const key = this.keyOf(tokenOrKey)
    let entry = this.entries_.get(key)
    if (entry) entry.user = user
    else {
      // A stand-in names only a session this store holds; one already gone starts nothing.
      if (tokenOrKey.startsWith('restored:')) return this
      const at = this.now()
      entry = {
        user,
        createdAt: at,
        lastSeenAt: at,
        flags: {},
        token: tokenOrKey,
        checkedAt: at,
        persisted: false,
        storedSeenAt: at,
      }
      this.entries_.set(key, entry)
    }
    this.persist(key, entry)
    return this
  }

  delete(tokenOrKey: string) {
    return this.forget(this.keyOf(tokenOrKey))
  }

  /** The key a token is stored under (see sessionKey). */
  keyFor(token: string) {
    return sessionKey(token)
  }

  /**
   * Brings this server's copy of a token's session up to date with the store before a request uses it: reads it when
   * it is not held here or was last checked more than `recheckMs` ago. A session signed out elsewhere is dropped; one
   * made elsewhere is taken in. When the store cannot be read, the copy held here is used, as without a store.
   */
  async ready(token: string | undefined) {
    if (!this.persistence || !token) return
    const key = sessionKey(token)
    const held = this.entries_.get(key)
    if (held && this.now() - held.checkedAt < this.recheckMs) return
    const pending = this.reads.get(key)
    if (pending) return pending
    const read = this.recall(key, token).finally(() => this.reads.delete(key))
    this.reads.set(key, read)
    return read
  }

  private async recall(key: string, token: string) {
    const persistence = this.persistence as SessionPersistence<T>
    let stored: StoredSession<T> | null
    try {
      await this.writes.get(key)
      stored = await persistence.load(key)
    } catch (error) {
      this.onError(error)
      return
    }
    const held = this.entries_.get(key)
    const at = this.now()
    if (!stored) {
      // Never stored (the store was down when it was made): store it now rather than sign the person out.
      if (held && !held.persisted) this.persist(key, held)
      else if (held) this.drop(key)
      return
    }
    if (this.expired(stored, at)) {
      this.forget(key)
      return
    }
    if (held) {
      held.user = stored.user
      held.flags = stored.flags || {}
      held.lastSeenAt = Math.max(held.lastSeenAt, stored.lastSeenAt)
      held.checkedAt = at
      held.persisted = true
      return
    }
    this.take(key, stored, token, at)
  }

  private take(key: string, stored: StoredSession<T>, token: string | undefined, at: number) {
    const entry: Entry<T> = {
      user: stored.user,
      createdAt: stored.createdAt,
      lastSeenAt: stored.lastSeenAt,
      flags: stored.flags || {},
      token,
      checkedAt: at,
      persisted: true,
      storedSeenAt: stored.lastSeenAt,
    }
    this.entries_.set(key, entry)
    this.onRestore?.(key, {
      user: entry.user,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      flags: entry.flags,
    })
  }

  /**
   * Loads every live stored session (after a restart), so signing someone out everywhere reaches them all. Run again
   * every minute with several server instances: it takes in sessions made elsewhere and drops ones signed out
   * elsewhere. Returns how many sessions were taken in.
   */
  async restore() {
    if (!this.persistence) return 0
    const started = this.now()
    let stored: [string, StoredSession<T>][]
    try {
      stored = await this.persistence.loadAll(started)
    } catch (error) {
      this.onError(error)
      return 0
    }
    const at = this.now()
    const live = new Set(stored.map(([key]) => key))
    let restored = 0
    for (const [key, session] of stored) {
      if (this.entries_.has(key) || this.expired(session, at)) continue
      this.take(key, session, undefined, at)
      restored += 1
    }
    // Held here and stored before, but no longer stored: signed out on another server. A session written or read
    // since the list was taken, or whose write is still on its way (or failed), is left alone.
    for (const [key, entry] of this.entries_)
      if (
        entry.persisted &&
        entry.checkedAt < started &&
        !live.has(key) &&
        !this.writes.has(key) &&
        !this.reads.has(key)
      )
        this.drop(key)
    return restored
  }

  /** Waits for the writes started so far (tests, shutdown). */
  async flush() {
    await Promise.all([...this.writes.values()])
  }

  /** Live sessions only, by token (or a stand-in for a restored session not presented yet). Safe to delete or set while iterating. */
  *entries(): IterableIterator<[string, T]> {
    const at = this.now()
    for (const [key, entry] of this.entries_) {
      if (this.expired(entry, at)) {
        this.forget(key)
        continue
      }
      yield [entry.token ?? this.handleOf(key, entry), entry.user]
    }
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  /** Drops expired sessions that nobody has presented again, so abandoned tokens do not pile up. */
  prune() {
    const at = this.now()
    let removed = 0
    for (const [key, entry] of this.entries_) {
      if (this.expired(entry, at)) {
        this.drop(key)
        removed += 1
      }
    }
    if (this.persistence) void this.persistence.prune(at).catch(error => this.onError(error))
    return removed
  }

  get size() {
    return this.entries_.size
  }
}
