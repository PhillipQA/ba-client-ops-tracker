import { IntegrationError } from './tenant-integrations'

export class GithubError extends IntegrationError {
  constructor(
    message: string,
    status: number,
    public retryAfterSeconds?: number,
  ) {
    super(message, status)
  }
}

export function githubRepositoryName(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 200 ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value) ||
    value.split('/').some(part => /^\.+$/.test(part))
  )
    throw new IntegrationError('Enter a repository as owner/repository.')
  return value
}
export function githubRepoPath(repository: string) {
  return `/repos/${githubRepositoryName(repository).split('/').map(encodeURIComponent).join('/')}`
}

/** Every request uses GitHub's fixed API origin. Provider errors never echo tokens. */
export async function githubRequest(token: string, path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new IntegrationError('Invalid GitHub request.')
  let response: Response
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'BA-Client-Ops-Tracker',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new GithubError('Could not reach GitHub. Your saved tickets are still available; retry shortly.', 502)
  }
  if (!response.ok) {
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
    ) {
      const seconds =
        Number(response.headers.get('retry-after')) ||
        Math.ceil((Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now()) / 1000) ||
        60
      throw new GithubError(
        'GitHub has temporarily limited requests. Sync will resume after the limit resets.',
        429,
        Math.max(60, Math.min(86400, seconds)),
      )
    }
    if (response.status === 401)
      throw new GithubError(
        'GitHub token expired or was revoked. Replace your personal token in My GitHub settings.',
        409,
      )
    if (response.status === 403)
      throw new GithubError(
        'GitHub denied access. Check token repository permissions, organization approval and SSO authorization.',
        403,
      )
    if (response.status === 404)
      throw new GithubError(
        'GitHub repository or ticket is unavailable to your token. Check selected repositories and access.',
        404,
      )
    throw new GithubError('GitHub could not complete the request. Retry shortly.', 502)
  }
  try {
    return await response.json()
  } catch {
    throw new GithubError('GitHub returned an unreadable response. Retry shortly.', 502)
  }
}

export function githubIdentity(value: any) {
  if (
    !Number.isSafeInteger(value?.id) ||
    value.id < 1 ||
    typeof value.login !== 'string' ||
    !/^[a-z0-9-]{1,100}$/i.test(value.login)
  )
    throw new IntegrationError('Could not identify the account for this GitHub token.', 502)
  return { id: value.id as number, login: value.login as string }
}

/** Product fields only; local QA status and task links are deliberately omitted from sync updates. */
export function githubIssue(value: any, repository: string, login: string) {
  if (value?.pull_request) return null
  if (
    !Number.isSafeInteger(value?.id) ||
    value.id < 1 ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !['open', 'closed'].includes(value.state) ||
    typeof value.title !== 'string' ||
    typeof value.user?.login !== 'string' ||
    ![value.created_at, value.updated_at].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date)))
  )
    throw new IntegrationError('GitHub returned an invalid ticket. Retry sync.', 502)
  const assignees: string[] = (Array.isArray(value.assignees) ? value.assignees : [])
    .map((a: any) => String(a?.login || ''))
    .filter(Boolean)
  return {
    github_id: value.id as number,
    number: value.number as number,
    repository,
    title: value.title.slice(0, 500),
    body: String(value.body || '').slice(0, 60000),
    html_url: `https://github.com/${repository}/issues/${value.number}`,
    state: value.state as 'open' | 'closed',
    state_reason: typeof value.state_reason === 'string' ? value.state_reason.slice(0, 100) : null,
    creator: value.user.login as string,
    assignees,
    labels: (Array.isArray(value.labels) ? value.labels : [])
      .map((l: any) => (typeof l === 'string' ? l : String(l?.name || '')))
      .filter(Boolean)
      .slice(0, 100),
    milestone: String(value.milestone?.title || '').slice(0, 300),
    comments_count: Math.max(0, Math.min(1000000, Number(value.comments) || 0)),
    created_at: value.created_at as string,
    updated_at: value.updated_at as string,
    created_by_me: value.user.login.toLowerCase() === login.toLowerCase(),
    assigned_to_me: assignees.some(a => a.toLowerCase() === login.toLowerCase()),
    available: true,
  }
}
