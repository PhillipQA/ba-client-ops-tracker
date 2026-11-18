import test from 'node:test'
import assert from 'node:assert/strict'
import {
  gitlabOrigin,
  gitTicketKey,
  parseGithubIssueUrl,
  parseGitlabIssueUrl,
  parseGitTicketUrl,
} from '../src/features/trackers/gitTicketUrl'

const ok = (result: ReturnType<typeof parseGithubIssueUrl>) => {
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  return (result as Extract<typeof result, { ok: true }>).ref
}
const refused = (result: ReturnType<typeof parseGithubIssueUrl>) => assert.equal(result.ok, false)

test('GitHub issue links are read into provider, repository and number', () => {
  assert.deepEqual(ok(parseGithubIssueUrl('https://github.com/PhillipQA/ba-client-ops-tracker/issues/42')), {
    provider: 'github',
    instanceUrl: 'https://github.com',
    repository: 'PhillipQA/ba-client-ops-tracker',
    number: 42,
  })
  assert.equal(ok(parseGithubIssueUrl('https://www.github.com/o/r.js/issues/7/')).repository, 'o/r.js')
  assert.equal(ok(parseGithubIssueUrl('https://github.com/o/r/issues/7#issuecomment-1')).number, 7)
  assert.equal(ok(parseGithubIssueUrl('  https://github.com/o/r/issues/7?x=1  ')).number, 7)
})

test('GitHub links that are not an issue page are refused', () => {
  for (const url of [
    '',
    'github.com/o/r/issues/1',
    'http://github.com/o/r/issues/1',
    'https://user:pass@github.com/o/r/issues/1',
    'https://github.com:8443/o/r/issues/1',
    'https://gitlab.com/o/r/issues/1',
    'https://github.com.evil.com/o/r/issues/1',
    'https://github.com/o/r/pull/1',
    'https://github.com/o/r/issues',
    'https://github.com/o/r/issues/0',
    'https://github.com/o/r/issues/01',
    'https://github.com/o/r/issues/1x',
    'https://github.com/o/r/issues/99999999999',
    'https://github.com/-o/r/issues/1',
    'https://github.com/o/../issues/1',
    'https://github.com/o/r/issues/1/comments',
    'https://github.com/o/r with space/issues/1',
  ])
    refused(parseGithubIssueUrl(url))
  const pull = parseGithubIssueUrl('https://github.com/o/r/pull/3')
  assert.match(pull.ok ? '' : pull.error, /pull request/)
})

test('GitLab issue links must be on the person’s own instance', () => {
  assert.deepEqual(ok(parseGitlabIssueUrl('https://gitlab.com/group/sub/project/-/issues/15', 'https://gitlab.com')), {
    provider: 'gitlab',
    instanceUrl: 'https://gitlab.com',
    repository: 'group/sub/project',
    number: 15,
  })
  assert.equal(
    ok(parseGitlabIssueUrl('https://git.company.ph/team/app/-/work_items/3', 'https://GIT.company.ph/')).instanceUrl,
    'https://git.company.ph',
  )
  for (const url of [
    'https://gitlab.com/group/project/-/issues/1',
    'https://other.example.com/group/project/-/issues/1',
  ])
    refused(parseGitlabIssueUrl(url, 'https://git.company.ph'))
  refused(parseGitlabIssueUrl('https://gitlab.com/g/p/-/issues/1', ''))
  refused(parseGitlabIssueUrl('https://gitlab.com/g/p/-/issues/1', 'http://gitlab.com'))
})

test('GitLab links that are not an issue page are refused', () => {
  for (const url of [
    'https://gitlab.com/project/-/issues/1',
    'https://gitlab.com/g/p/-/merge_requests/1',
    'https://gitlab.com/g/p/-/issues',
    'https://gitlab.com/g/p/-/issues/0',
    'https://gitlab.com/g/p/-/issues/1/designs',
    'https://gitlab.com/g/p/issues/1',
    'https://gitlab.com/g/p.git/-/issues/1',
    'https://gitlab.com/g/..x/-/issues/1',
    'http://gitlab.com/g/p/-/issues/1',
  ])
    refused(parseGitlabIssueUrl(url, 'https://gitlab.com'))
  const merge = parseGitlabIssueUrl('https://gitlab.com/g/p/-/merge_requests/1', 'https://gitlab.com')
  assert.match(merge.ok ? '' : merge.error, /merge request/)
})

test('Either provider: GitHub by host, anything else as GitLab on the person’s instance', () => {
  assert.equal(ok(parseGitTicketUrl('https://github.com/o/r/issues/1', 'https://gitlab.com')).provider, 'github')
  assert.equal(ok(parseGitTicketUrl('https://gitlab.com/g/p/-/issues/1', 'https://gitlab.com')).provider, 'gitlab')
  refused(parseGitTicketUrl('https://gitlab.com/g/p/-/issues/1'))
})

test('Ticket keys use the provider’s issue id, not the link text', () => {
  assert.equal(gitlabOrigin('https://GitLab.com/'), 'https://gitlab.com')
  assert.equal(gitlabOrigin('ftp://gitlab.com'), '')
  assert.equal(gitTicketKey('gitlab', 'https://GitLab.com/', 991), 'gitlab:https://gitlab.com:991')
  assert.equal(gitTicketKey('github', '', 5), 'github:https://github.com:5')
})
