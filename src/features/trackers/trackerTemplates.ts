import type { ColumnType, OptionColor } from './trackerModel'

/** Starting points. Every template can be changed afterwards: rename, reorder, add or remove columns. */
export type TemplateColumn = {
  name: string
  type: ColumnType
  options?: { label: string; color: OptionColor }[]
  revealBy?: 'editors' | 'admins'
}
export type TrackerTemplate = { id: string; name: string; about: string; columns: TemplateColumn[] }

const status = (...labels: [string, OptionColor][]) => labels.map(([label, color]) => ({ label, color }))
const progress = status(['Not started', 'gray'], ['In progress', 'blue'], ['Live', 'green'], ['Delayed', 'amber'])

export const TRACKER_TEMPLATES: TrackerTemplate[] = [
  {
    id: 'site-rollout',
    name: 'Site rollout',
    about: 'Sites with go-live dates, owners, sign-off and access details.',
    columns: [
      { name: 'Site', type: 'text' },
      { name: 'Go-live', type: 'date' },
      { name: 'Status', type: 'select', options: progress },
      { name: 'Owner', type: 'person' },
      { name: 'Task status', type: 'task_status' },
      { name: 'Sign-off', type: 'signoff' },
      { name: 'Drive files', type: 'drive_files' },
      { name: 'Admin login', type: 'secret' },
      { name: 'Notes', type: 'longtext' },
    ],
  },
  {
    id: 'pos-bir',
    name: 'POS installation & BIR permits',
    about: 'Branch installs with permit and COR status.',
    columns: [
      { name: 'Branch', type: 'text' },
      { name: 'Installation date', type: 'date' },
      {
        name: 'Status',
        type: 'select',
        options: status(['Not started', 'gray'], ['Scheduled', 'blue'], ['Installed', 'green'], ['Blocked', 'amber']),
      },
      { name: 'Owner', type: 'person' },
      {
        name: 'BIR permit',
        type: 'select',
        options: status(['Not filed', 'gray'], ['Filed', 'blue'], ['Approved', 'green'], ['Rejected', 'red']),
      },
      { name: 'COR received', type: 'checkbox' },
      { name: 'Permit number', type: 'text' },
      { name: 'Sign-off', type: 'signoff' },
      { name: 'Drive files', type: 'drive_files' },
      { name: 'Notes', type: 'longtext' },
    ],
  },
  {
    id: 'defects',
    name: 'Defect & enhancement log',
    about: 'Issues with severity, owner and a link to the Git issue.',
    columns: [
      { name: 'Title', type: 'text' },
      { name: 'Type', type: 'select', options: status(['Defect', 'red'], ['Enhancement', 'blue']) },
      { name: 'Severity', type: 'select', options: status(['Low', 'gray'], ['Medium', 'amber'], ['High', 'red']) },
      {
        name: 'Status',
        type: 'select',
        options: status(['Open', 'blue'], ['In progress', 'amber'], ['Fixed', 'green'], ['Closed', 'gray']),
      },
      { name: 'Owner', type: 'person' },
      { name: 'Reported on', type: 'date' },
      { name: 'Git issue', type: 'link' },
      { name: 'Task status', type: 'task_status' },
      { name: 'Notes', type: 'longtext' },
    ],
  },
  {
    id: 'client-tickets',
    name: 'Client ticket tracker',
    about: 'Requests per client with status, priority and the email thread.',
    columns: [
      { name: 'Request', type: 'text' },
      { name: 'Requested by', type: 'text' },
      { name: 'Received', type: 'date' },
      {
        name: 'Status',
        type: 'select',
        options: status(['New', 'blue'], ['In progress', 'amber'], ['Waiting on client', 'purple'], ['Done', 'green']),
      },
      { name: 'Priority', type: 'select', options: status(['Low', 'gray'], ['Normal', 'blue'], ['Urgent', 'red']) },
      { name: 'Owner', type: 'person' },
      { name: 'Due', type: 'task_due' },
      { name: 'Email thread', type: 'link' },
      { name: 'Notes', type: 'longtext' },
    ],
  },
  {
    id: 'blank',
    name: 'Blank tracker',
    about: 'Start empty and add your own columns.',
    columns: [{ name: 'Name', type: 'text' }],
  },
]

export const templateById = (id: string) => TRACKER_TEMPLATES.find(template => template.id === id)
