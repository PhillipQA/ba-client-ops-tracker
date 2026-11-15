/**
 * Job roles: what each kind of person in the company sees and changes.
 *
 * Administrators see and change everything. Everyone else gets the pages of their job role(s): picked for them in
 * Users & Permissions, and taken from Seeds per client or project (someone can be PM on one project and QA on
 * another). Roles add up. A person with no job role keeps the modules picked for them by hand, as before.
 * Administrators edit the roles in Settings › Roles; these are the starting set.
 */
import { type ActionCenterLayout, cleanLayout } from './actionCenterLayout'
import type { AppModule } from './types'
import { asList as list } from './lists'

export interface JobRole {
  id: string
  name: string
  /** Pages this role sees. */
  modules: AppModule[]
  /** Of those, the ones it can change. A role that changes nothing is a Viewer. */
  edit: AppModule[]
  /** Titles Seeds may use for this role (matched without case, spaces or punctuation). */
  seedsTitles: string[]
  /** Built-in roles can be edited but not deleted. */
  builtIn?: boolean
  /** The Action Center layout people with this role start from (saved by an Administrator). */
  actionCenter?: ActionCenterLayout
}

export const ROLE_MODULES: AppModule[] = [
  'action',
  'clients',
  'projects',
  'items',
  'inbox',
  'documents',
  'requirements',
  'trackers',
  'reports',
  'explorer',
  'ai',
]

const seeds: AppModule[] = ['clients', 'projects', 'items']
export const DEFAULT_JOB_ROLES: JobRole[] = [
  {
    id: 'BA',
    name: 'Business Analyst',
    modules: [...ROLE_MODULES],
    edit: [...ROLE_MODULES],
    seedsTitles: ['BA', 'Business Analyst', 'Analyst'],
  },
  {
    id: 'PM',
    name: 'Project Manager',
    modules: ['action', ...seeds, 'inbox', 'trackers', 'requirements', 'reports', 'explorer', 'ai'],
    edit: ['action', ...seeds, 'inbox', 'trackers', 'ai'],
    seedsTitles: ['PM', 'Project Manager', 'Manager'],
  },
  {
    id: 'PO',
    name: 'Product Owner',
    modules: ['action', ...seeds, 'requirements', 'documents', 'reports', 'explorer', 'ai'],
    edit: ['action', 'requirements', 'documents', 'ai'],
    seedsTitles: ['PO', 'Product Owner'],
  },
  {
    id: 'DEV',
    name: 'Developer',
    modules: ['action', 'items', 'inbox', 'requirements', 'ai'],
    edit: ['action', 'items', 'inbox', 'ai'],
    seedsTitles: ['DEV', 'Developer', 'Software Engineer', 'Engineer', 'Programmer'],
  },
  {
    id: 'QA',
    name: 'Quality Assurance',
    modules: ['action', 'items', 'requirements', 'documents', 'trackers', 'ai'],
    edit: ['action', 'items', 'documents', 'trackers', 'ai'],
    seedsTitles: ['QA', 'Quality Assurance', 'Tester', 'QA Engineer'],
  },
  {
    id: 'SUPPORT',
    name: 'Support',
    modules: ['action', 'items', 'inbox', 'ai'],
    edit: ['action', 'items', 'inbox', 'ai'],
    seedsTitles: ['Support', 'Support Engineer', 'Helpdesk', 'Technical Support'],
  },
  {
    id: 'AM',
    name: 'Account Manager',
    modules: ['action', 'reports', 'explorer', 'ai'],
    edit: [],
    seedsTitles: ['AM', 'Account Manager', 'Account'],
  },
].map(role => ({ ...role, builtIn: true }) as JobRole)

const text = (value: unknown) => (value == null ? '' : String(value).trim())
export const titleKey = (value: unknown) =>
  text(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

export const MAX_JOB_ROLES = 40

export function cleanJobRole(raw: any): JobRole | null {
  const id = text(raw?.id)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 20)
  const name = text(raw?.name).slice(0, 40)
  if (!id || !name) return null
  const modules = ROLE_MODULES.filter(module => list(raw?.modules).includes(module))
  const edit = modules.filter(module => list(raw?.edit).includes(module))
  const seedsTitles = [...new Set(list(raw?.seedsTitles).map(text).filter(Boolean))]
    .slice(0, 12)
    .map(t => t.slice(0, 40))
  const actionCenter = cleanLayout(raw?.actionCenter)
  return {
    id,
    name,
    modules,
    edit,
    seedsTitles,
    ...(raw?.builtIn ? { builtIn: true } : {}),
    ...(actionCenter ? { actionCenter } : {}),
  }
}

/** The account's roles: its own edits and additions over the starting set. Built-in roles cannot go missing. */
export function jobRoles(state: any): JobRole[] {
  const saved = list(state?.jobRoles)
    .map(cleanJobRole)
    .filter((role): role is JobRole => Boolean(role))
  const byId = new Map(saved.map(role => [role.id, role]))
  const builtIn = DEFAULT_JOB_ROLES.map(role => {
    const own = byId.get(role.id)
    return own ? { ...own, builtIn: true } : role
  })
  const custom = saved.filter(role => !DEFAULT_JOB_ROLES.some(builtInRole => builtInRole.id === role.id))
  return [...builtIn, ...custom.map(role => ({ ...role, builtIn: undefined }))].slice(0, MAX_JOB_ROLES)
}

/** The role a Seeds title stands for, if any. */
export function roleForSeedsTitle(state: any, title: unknown): string | null {
  const key = titleKey(title)
  if (!key) return null
  for (const role of jobRoles(state))
    if (titleKey(role.id) === key || titleKey(role.name) === key || role.seedsTitles.some(t => titleKey(t) === key))
      return role.id
  return null
}

/** A role that changes nothing is read-only on its clients and projects. */
export function roleCanChange(state: any, roleId: string) {
  const role = jobRoles(state).find(candidate => candidate.id === roleId)
  return role ? role.edit.length > 0 : true
}

export interface RoleAccess {
  roles: string[]
  modules: AppModule[]
  edit: AppModule[]
}

/** The pages a set of roles opens, and the ones it may change. */
export function accessForRoles(state: any, roleIds: string[]): RoleAccess | null {
  const roles = jobRoles(state).filter(role => roleIds.includes(role.id))
  if (!roles.length) return null
  const modules = new Set<AppModule>()
  const edit = new Set<AppModule>()
  for (const role of roles) {
    for (const module of role.modules) modules.add(module)
    for (const module of role.edit) edit.add(module)
  }
  return { roles: roles.map(role => role.id), modules: [...modules], edit: [...edit] }
}
