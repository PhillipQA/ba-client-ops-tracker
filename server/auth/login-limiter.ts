/**
 * Failed-login throttling. A single counter keyed on IP + account + username is easy to dodge:
 * one common password tried against every username never trips it, and a botnet never repeats an IP.
 * Three counters close those gaps:
 *   attempt - this address against this user (the original limit, strictest)
 *   user    - this user from any address, at a higher threshold so a lockout needs sustained abuse
 *   ip      - this address across every user
 * Any one of them reaching its limit blocks the request.
 */
export type LoginIdentity = { ip: string; account: string; username: string }
export type RateState = { limit: number; remaining: number; resetAt: number }
export type LoginCheck = { blocked: boolean; retryAfterSeconds: number; rate: RateState | null }

type Entry = { count: number; resetAt: number }

export type LoginLimiterOptions = {
  windowMs?: number
  maxPerAttempt?: number
  maxPerUser?: number
  maxPerIp?: number
  now?: () => number
}

export function createLoginLimiter(options: LoginLimiterOptions = {}) {
  const windowMs = options.windowMs ?? 15 * 60 * 1000
  const maxPerAttempt = options.maxPerAttempt ?? 5
  const maxPerUser = options.maxPerUser ?? 20
  const maxPerIp = options.maxPerIp ?? 40
  const now = options.now ?? Date.now
  const failures = new Map<string, Entry>()

  const clean = (value: string) =>
    String(value || '')
      .trim()
      .toLowerCase()
  function keys(identity: LoginIdentity) {
    const ip = String(identity.ip || 'unknown')
    const account = clean(identity.account)
    const username = clean(identity.username)
    return {
      attempt: { key: `attempt:${ip}:${account}:${username}`, max: maxPerAttempt },
      user: { key: `user:${account}:${username}`, max: maxPerUser },
      ip: { key: `ip:${ip}`, max: maxPerIp },
    }
  }
  function active(key: string) {
    const entry = failures.get(key)
    if (!entry) return null
    if (entry.resetAt <= now()) {
      failures.delete(key)
      return null
    }
    return entry
  }
  const rateOf = (entry: Entry | null, max: number): RateState | null =>
    entry ? { limit: max, remaining: Math.max(0, max - entry.count), resetAt: entry.resetAt } : null

  return {
    check(identity: LoginIdentity): LoginCheck {
      const { attempt, user, ip } = keys(identity)
      let blockedUntil = 0
      for (const { key, max } of [attempt, user, ip]) {
        const entry = active(key)
        if (entry && entry.count >= max) blockedUntil = Math.max(blockedUntil, entry.resetAt)
      }
      const rate = rateOf(active(attempt.key), attempt.max)
      if (!blockedUntil) return { blocked: false, retryAfterSeconds: 0, rate }
      return {
        blocked: true,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now()) / 1000)),
        rate: rate ? { ...rate, remaining: 0 } : { limit: attempt.max, remaining: 0, resetAt: blockedUntil },
      }
    },
    /** Counts one failure against every counter and returns the per-attempt state for response headers. */
    recordFailure(identity: LoginIdentity): RateState {
      const all = keys(identity)
      let result: RateState = { limit: all.attempt.max, remaining: 0, resetAt: now() + windowMs }
      for (const { key, max } of [all.ip, all.user, all.attempt]) {
        const current = active(key)
        const next: Entry = current
          ? { count: current.count + 1, resetAt: current.resetAt }
          : { count: 1, resetAt: now() + windowMs }
        failures.set(key, next)
        result = rateOf(next, max)!
      }
      return result
    },
    /**
     * Only the address-and-user counter is reset. The per-user and per-address counters keep running,
     * so a lucky guess among many wrong ones does not wipe out the evidence of an attack.
     */
    recordSuccess(identity: LoginIdentity) {
      failures.delete(keys(identity).attempt.key)
    },
    prune() {
      const at = now()
      for (const [key, entry] of failures) if (entry.resetAt <= at) failures.delete(key)
    },
    get size() {
      return failures.size
    },
  }
}
