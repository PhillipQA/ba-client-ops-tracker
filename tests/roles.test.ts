import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_JOB_ROLES, jobRoles } from '../src/shared/roles'
import { planJobRoles } from '../server/workspace/workflow-routes'

const builtIn = () => DEFAULT_JOB_ROLES.map(role => ({ ...role }))

test('the starting roles are there until an account changes them', () => {
  assert.deepEqual(
    jobRoles({}).map(role => role.id),
    ['BA', 'PM', 'PO', 'DEV', 'QA', 'SUPPORT', 'AM'],
  )
  assert.deepEqual(jobRoles({}).find(role => role.id === 'AM')?.edit, [])
})

test('Administrators edit and add roles; built-in ones stay, roles in use stay', () => {
  const roles = [
    ...builtIn(),
    {
      id: 'BO',
      name: 'Business Owner',
      modules: ['action', 'reports', 'secret'],
      edit: ['reports', 'ai'],
      seedsTitles: ['Sponsor'],
    },
  ]
  const saved = planJobRoles({}, roles)
  const owner = jobRoles(saved).find(role => role.id === 'BO')
  assert.deepEqual(owner?.modules, ['action', 'reports'], 'unknown pages are dropped')
  assert.deepEqual(owner?.edit, ['reports'], 'a role changes only pages it sees')
  assert.throws(
    () =>
      planJobRoles(
        {},
        builtIn().filter(role => role.id !== 'QA'),
      ),
    /built in/,
  )
  const inUse = { ...saved, accounts: [{ id: 'u', jobRoles: ['BO'] }] }
  assert.throws(() => planJobRoles(inUse, builtIn()), /still given to people/)
  assert.doesNotThrow(() => planJobRoles(saved, builtIn()), 'an unused custom role can go')
  assert.throws(
    () => planJobRoles({}, [...builtIn(), { id: 'X', name: 'X', modules: [], edit: [], seedsTitles: ['tester'] }]),
    /one role only/,
  )
  assert.throws(
    () => planJobRoles({}, [...builtIn(), { id: 'QA', name: 'Dup', modules: [], edit: [], seedsTitles: [] }]),
    /unique/,
  )
})
