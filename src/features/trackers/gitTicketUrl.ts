/**
 * GitLab and GitHub issue links, read strictly. Only an issue's own page is accepted: no pull or merge requests, no
 * lists, no other sites. The server reads the link again before it trusts it, and then fetches the issue with the
 * person's own connection, so a link alone never adds a ticket.
 *
 * Pure functions, shared by Work Hub and the server.
 */

export type GitProvider = 'github' | 'gitlab'

export type GitTicketRef = {
  provider: GitProvider
  /** https://github.com for GitHub; the GitLab instance's origin (https://gitlab.com, https://gitlab.company.com). */
  instanceUrl: string
  /** owner/repository on GitHub; group/subgroup/project on GitLab. */
  repository: string
  /** The issue's number in its repository (GitHub number, GitLab iid). */
  number: number
}

export type GitTicketUrlResult = { ok: true; ref: GitTicketRef } | { ok: false; error: string }

export const GITHUB_ORIGIN = 'https://github.com'
const MAX_NUMBER = 2_147_483_647
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/
const GITLAB_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/
const GITLAB_MAX_DEPTH = 20

const fail = (error: string): GitTicketUrlResult => ({ ok: false, error })

/** The origin of a GitLab instance URL as stored with a connection (https only, no path), or '' when it is not one. */
export function gitlabOrigin(instanceUrl: string): string {
  try {
    const url = new URL(String(instanceUrl || '').trim())
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    return url.origin.toLowerCase()
  } catch {
    return ''
  }
}

function issueNumber(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]{0,9}$/.test(value)) return 0
  const number = Number(value)
  return number <= MAX_NUMBER ? number : 0
}

function parsed(raw: string): URL | null {
  const text = String(raw || '').trim()
  if (!text || text.length > 2000 || /\s/.test(text)) return null
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** A GitHub issue page: https://github.com/<owner>/<repository>/issues/<number>. */
export function parseGithubIssueUrl(raw: string): GitTicketUrlResult {
  const url = parsed(raw)
  if (!url) return fail('Enter the full link to a GitHub issue.')
  if (url.protocol !== 'https:' || url.username || url.password) return fail('Use the https:// link to the GitHub issue.')
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return fail('This is not a github.com link.')
  if (url.port) return fail('This is not a github.com link.')
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (parts.length === 4 && parts[2] === 'pull') return fail('This is a pull request. Add an issue instead.')
  if (parts.length !== 4 || parts[2] !== 'issues') return fail('This GitHub link is not an issue page.')
  const [owner, repo, , numberText] = parts
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO.test(repo) || repo === '.' || repo === '..')
    return fail('This GitHub link has an invalid owner or repository.')
  const number = issueNumber(numberText)
  if (!number) return fail('This GitHub link has an invalid issue number.')
  return { ok: true, ref: { provider: 'github', instanceUrl: GITHUB_ORIGIN, repository: `${owner}/${repo}`, number } }
}

/**
 * A GitLab issue page on the person's own instance: <instance>/<group>/…/<project>/-/issues/<iid>. Work item pages
 * (/-/work_items/<iid>) are accepted too, since newer GitLab opens issues there; the server checks it is an issue.
 */
export function parseGitlabIssueUrl(raw: string, instanceUrl: string): GitTicketUrlResult {
  const origin = gitlabOrigin(instanceUrl)
  if (!origin) return fail('Connect GitLab first: its website address is needed to check the link.')
  const url = parsed(raw)
  if (!url) return fail('Enter the full link to a GitLab issue.')
  if (url.protocol !== 'https:' || url.username || url.password) return fail('Use the https:// link to the GitLab issue.')
  if (url.origin.toLowerCase() !== origin) return fail(`This link is not on your GitLab (${origin}).`)
  const path = url.pathname.replace(/\/+$/, '')
  const at = path.indexOf('/-/')
  if (at < 1) return fail('This GitLab link is not an issue page.')
  const project = path.slice(1, at).split('/')
  const tail = path.slice(at + 3).split('/')
  if (tail.length === 2 && tail[0] === 'merge_requests') return fail('This is a merge request. Add an issue instead.')
  if (tail.length !== 2 || (tail[0] !== 'issues' && tail[0] !== 'work_items'))
    return fail('This GitLab link is not an issue page.')
  if (project.length < 2 || project.length > GITLAB_MAX_DEPTH || !project.every(part => GITLAB_SEGMENT.test(part)))
    return fail('This GitLab link has an invalid project path.')
  if (project.some(part => part.endsWith('.git') || part.endsWith('.atom') || /\.\./.test(part)))
    return fail('This GitLab link has an invalid project path.')
  const number = issueNumber(tail[1])
  if (!number) return fail('This GitLab link has an invalid issue number.')
  return { ok: true, ref: { provider: 'gitlab', instanceUrl: origin, repository: project.join('/'), number } }
}

/** Either provider: GitHub links by their host, anything else as a link on the person's GitLab instance. */
export function parseGitTicketUrl(raw: string, gitlabInstanceUrl = ''): GitTicketUrlResult {
  const url = parsed(raw)
  if (url && ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return parseGithubIssueUrl(raw)
  if (!gitlabInstanceUrl) return fail('Enter a GitHub issue link, or connect GitLab to add GitLab issue links.')
  return parseGitlabIssueUrl(raw, gitlabInstanceUrl)
}

/** The stable key of a ticket across people and trackers: provider, instance and the provider's own issue id. */
export const gitTicketKey = (provider: GitProvider, instanceUrl: string, issueId: number) =>
  `${provider}:${provider === 'github' ? GITHUB_ORIGIN : gitlabOrigin(instanceUrl)}:${issueId}`
