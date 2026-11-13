/**
 * Sending time logs to Seeds (POST /time-entries, docs/seeds-api.md).
 *
 * A write needs the app's Seeds token and the Google ID token of the employee it is for: Seeds checks the token and
 * records the time as that person. So each person sends their own entries, signed in with Google as the same email as
 * in this app. Every entry goes with an Idempotency-Key made from its id, so sending it again never makes a second
 * entry in Seeds. A sent entry keeps the Seeds id; it is then changed or removed in Seeds.
 */
import type { TimeEntry } from '../../src/features/tasks/effort'
import { seedsProductFor } from '../../src/shared/seeds'
import { SeedsError } from './seeds-client'

export type SeedsTimeBody = {
  postDate: string
  projectId: number
  minuteslogged: number
  taskId: number | null
  parentId: number | null
  productId: number | null
  /** Left out when empty (optional unless Seeds requires remarks on the project). */
  remarks?: string
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const seedsNumber = (value: unknown) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 ? number : null
}

/** What Seeds is sent for one entry, or why it cannot be. */
export function seedsTimeBody(
  state: any,
  task: any,
  entry: TimeEntry,
  /** A product chosen when sending, for entries that have none of their own. */
  fallbackProductId?: string,
): { ok: true; body: SeedsTimeBody } | { ok: false; error: string } {
  const project = list(state?.projects).find(candidate => candidate?.id === task?.projectId)
  const projectId = seedsNumber(project?.seedsId)
  if (!projectId) return { ok: false, error: 'Its task is not under a Seeds project.' }
  // The project's time-entry rules and defaults from Seeds: a missing task or product takes the project's default.
  // A Seeds task, product and remarks are optional unless Seeds requires them.
  const rules = project?.seedsTimeRules || {}
  const taskId = seedsNumber(entry.seedsTaskId) ?? seedsNumber(rules.defaultTaskId)
  if (!taskId && rules.taskRequired === true)
    return { ok: false, error: 'Seeds requires a Seeds task on this project. Log it again with the Seeds task.' }
  // The product: chosen on the entry, else the one chosen when sending, else the task's, the project's or Seeds'
  // default; required when Seeds says so.
  const product = seedsProductFor(state, task, taskId ? String(taskId) : '')
  const productId = seedsNumber(entry.productId) ?? seedsNumber(fallbackProductId) ?? seedsNumber(product.productId)
  if (product.required && !productId)
    return {
      ok: false,
      error: 'Seeds requires a product here. Choose the Seeds product in Log time, then send again.',
    }
  const client = list(state?.clients).find(candidate => candidate?.id === project?.clientId)
  // The parent (client company): the project's client, else Seeds' default for the project.
  const parentId = seedsNumber(client?.seedsId) ?? seedsNumber(rules.defaultParentId)
  if (!parentId && rules.parentRequired === true)
    return { ok: false, error: 'Seeds requires the client (parent) on this project, and none is linked.' }
  const minutes = Math.round(Number(entry.hours) * 60)
  if (!(minutes >= 15 && minutes % 15 === 0)) return { ok: false, error: 'Its duration is not in 15-minute steps.' }
  const remarks = String(entry.note || '').trim()
  if (!remarks && rules.remarksRequired === true) return { ok: false, error: 'Seeds requires remarks on this project.' }
  return {
    ok: true,
    body: {
      postDate: entry.date,
      projectId,
      minuteslogged: minutes,
      taskId,
      parentId,
      productId,
      ...(remarks ? { remarks: remarks.slice(0, 120) } : {}),
    },
  }
}

/** The stable Idempotency-Key for an entry: retries of the same entry never make a second one in Seeds. */
export const seedsTimeKey = (entry: Pick<TimeEntry, 'id'>) => `ba-time-${entry.id}`.slice(0, 191)

/**
 * A light check of the Google ID token before it goes to Seeds (Seeds verifies the signature): for this app's Google
 * client, not expired, and the same verified email as this person here, so nobody's time is sent as someone else.
 */
export function checkGoogleIdToken(
  idToken: unknown,
  expected: { clientId: string; email: string; now: number },
): { ok: true } | { ok: false; error: string } {
  const parts = typeof idToken === 'string' ? idToken.split('.') : []
  if (parts.length !== 3) return { ok: false, error: 'Sign in with Google to send time to Seeds.' }
  let claims: any
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return { ok: false, error: 'Sign in with Google again.' }
  }
  if (claims?.aud !== expected.clientId) return { ok: false, error: 'That Google sign-in is not for this app.' }
  if (!(Number(claims?.exp) * 1000 > expected.now))
    return { ok: false, error: 'Your Google sign-in expired. Sign in again.' }
  const email = String(claims?.email || '').toLowerCase()
  if (!email || claims?.email_verified === false || email !== expected.email.toLowerCase())
    return {
      ok: false,
      error: `Sign in with Google as ${expected.email || 'the email on your account here'}: Seeds records time as the Google account that sends it.`,
    }
  return { ok: true }
}

/** Sends one entry. Resolves with the Seeds id, or throws a SeedsError with Seeds' reason. */
export async function postSeedsTime(input: {
  baseUrl: string
  token: string
  idToken: string
  key: string
  body: SeedsTimeBody
  request?: typeof fetch
}): Promise<string> {
  let response: Response
  try {
    response = await (input.request || fetch)(`${input.baseUrl}/time-entries`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'X-SEEDS-Google-ID-Token': input.idToken,
        'Idempotency-Key': input.key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input.body),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    throw new SeedsError('Seeds could not be reached.')
  }
  const answer: any = await response.json().catch(() => null)
  if (response.ok) {
    const data = answer?.data
    const id = data?.id ?? data?.entryId ?? data?.timeEntryId ?? data?.time_entry_id
    return id == null ? 'sent' : String(id)
  }
  const said = String(answer?.error?.message || '').slice(0, 200)
  if (response.status === 401) throw new SeedsError(`Seeds did not accept the sign-in.${said ? ` ${said}` : ''}`, 401)
  if (response.status === 403)
    throw new SeedsError(
      `Seeds did not allow it.${said ? ` ${said}` : ' The app may lack time-entry permission.'}`,
      403,
    )
  if (response.status === 429) throw new SeedsError('Seeds is busy. Try again in a minute.', 429)
  throw new SeedsError(said ? `Seeds said: ${said}` : `Seeds answered ${response.status}.`, response.status)
}
