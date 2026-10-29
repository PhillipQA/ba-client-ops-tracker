import { dayNumber, isoOf, isWeekend } from './timelineModel'
import type { Cell, ColumnType, OptionColor, TaskField, TrackerColumn } from './trackerModel'

/** Starting points. Every template can be changed afterwards: rename, reorder, add or remove columns. */
export type TemplateColumn = {
  name: string
  type: ColumnType
  options?: { label: string; color: OptionColor }[]
  revealBy?: 'editors' | 'admins'
  /** Mirrors this field of the task linked to each row (see trackerTasks). */
  taskField?: TaskField
}
/**
 * A starter row. `cells` are by column name; a Choice value is its option's label. `at` and `days` place it on the
 * calendar from the project start, in working days (Monday to Friday): `at` 0 is the start date itself.
 */
export type TemplateRow = { cells: Record<string, string | number>; at?: number; days?: number }
export type TrackerTemplate = {
  id: string
  name: string
  about: string
  columns: TemplateColumn[]
  /** Rows a new tracker starts with, which people then edit. */
  rows?: TemplateRow[]
  /** The column names that get the scheduled dates. */
  schedule?: { start: string; end: string }
  /** A Choice column that shows done when the linked task is completed, and completes it when set: option labels. */
  doneColumn?: { column: string; done: string; undone?: string }
  /** Each phase becomes a task and each row a subtask, in the tracker's client and project. */
  tasks?: boolean
}

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
    id: 'project-timeline',
    name: 'Project timeline',
    about: 'A project schedule by phase with start and end dates, % done and a Gantt timeline.',
    columns: [
      { name: 'Task', type: 'text', taskField: 'title' },
      { name: 'WBS', type: 'text' },
      {
        name: 'Phase',
        type: 'select',
        options: status(
          ['Project Planning', 'blue'],
          ['Data Build-up', 'purple'],
          ['Hardware & BIR', 'amber'],
          ['Setup', 'teal'],
          ['Training', 'pink'],
          ['UAT', 'blue'],
          ['Pre-Live', 'amber'],
          ['Go Live', 'green'],
          ['Support Turnover', 'gray'],
        ),
      },
      { name: 'Lead', type: 'text' },
      { name: 'Predecessor', type: 'text' },
      { name: 'Start', type: 'date', taskField: 'start' },
      { name: 'End', type: 'date', taskField: 'due' },
      { name: '% Done', type: 'number', taskField: 'progress' },
      {
        name: 'Status',
        type: 'select',
        options: status(['Pending', 'gray'], ['Ongoing', 'blue'], ['Done', 'green'], ['Delayed', 'red']),
      },
      { name: 'Man-days', type: 'number' },
      { name: 'Remarks', type: 'longtext' },
    ],
    doneColumn: { column: 'Status', done: 'Done', undone: 'Pending' },
    tasks: true,
    // A POS and RMS implementation, as in the HeroHub schedule. Every row, lead and date can be changed afterwards.
    schedule: { start: 'Start', end: 'End' },
    rows: [
      {
        cells: {
          WBS: '1.1',
          Task: 'Formal Kickoff',
          Phase: 'Project Planning',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
        },
        at: 0,
        days: 1,
      },
      {
        cells: {
          WBS: '1.2',
          Task: 'BPM Discussion',
          Phase: 'Project Planning',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '1.1',
        },
        at: 2,
        days: 1,
      },
      {
        cells: {
          WBS: '2.1',
          Task: 'Creation & Importing of Regular Products in RMS',
          Phase: 'Data Build-up',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '1.2',
        },
        at: 5,
        days: 20,
      },
      {
        cells: {
          WBS: '2.2',
          Task: 'Products Syncing in POS',
          Phase: 'Data Build-up',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '2.1',
        },
        at: 25,
        days: 1,
      },
      {
        cells: {
          WBS: '3.1',
          Task: 'Provide Certificate of Registration (COR)',
          Phase: 'Hardware & BIR',
          Lead: 'Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '1.1',
        },
        at: 5,
        days: 1,
      },
      {
        cells: {
          WBS: '3.2',
          Task: 'Purchase of POS Unit Hardware',
          Phase: 'Hardware & BIR',
          Lead: 'Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '1.1',
        },
        at: 6,
        days: 15,
      },
      {
        cells: {
          WBS: '3.3',
          Task: 'POS Unit Hardware Installation',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.2',
        },
        at: 21,
        days: 3,
      },
      {
        cells: {
          WBS: '3.4',
          Task: 'Submission of Dongle Request Form (DRF)',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.2',
        },
        at: 21,
        days: 5,
      },
      {
        cells: {
          WBS: '3.5',
          Task: 'POS Permit Application (Internal)',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.4',
        },
        at: 26,
        days: 10,
      },
      {
        cells: {
          WBS: '3.6',
          Task: 'Create E-Accreg Account & Submission of Sworn Statement to RDO',
          Phase: 'Hardware & BIR',
          Lead: 'Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.1',
        },
        at: 26,
        days: 10,
      },
      {
        cells: {
          WBS: '3.7',
          Task: 'POS Permit Decals',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.5',
        },
        at: 36,
        days: 5,
      },
      {
        cells: {
          WBS: '3.8',
          Task: 'Terminal and Template Settings Configuration',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.3',
        },
        at: 24,
        days: 3,
      },
      {
        cells: {
          WBS: '3.9',
          Task: 'POS License Validation & Initialization',
          Phase: 'Hardware & BIR',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '3.7',
        },
        at: 41,
        days: 2,
      },
      {
        cells: {
          WBS: '4.1',
          Task: 'System Training for RMS (Online)',
          Phase: 'Training',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '2.2',
        },
        at: 30,
        days: 1,
      },
      {
        cells: {
          WBS: '4.2',
          Task: 'System Training for POS (Onsite)',
          Phase: 'Training',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '4.1',
        },
        at: 31,
        days: 1,
      },
      {
        cells: {
          WBS: '5.1',
          Task: 'User Acceptance Testing (UAT)',
          Phase: 'UAT',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '4.2',
        },
        at: 32,
        days: 5,
      },
      {
        cells: {
          WBS: '6.1',
          Task: 'Dry Run',
          Phase: 'Pre-Live',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '5.1 & 3.9',
        },
        at: 43,
        days: 1,
      },
      {
        cells: {
          WBS: '6.2',
          Task: 'Final Configuration, POS and RMS Reset',
          Phase: 'Pre-Live',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '6.1',
        },
        at: 44,
        days: 1,
      },
      {
        cells: {
          WBS: '6.3',
          Task: 'Pcount',
          Phase: 'Pre-Live',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '6.1',
        },
        at: 44,
        days: 1,
      },
      {
        cells: {
          WBS: '7.1',
          Task: 'Go Live',
          Phase: 'Go Live',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '6.2 & 6.3',
        },
        at: 45,
        days: 1,
      },
      {
        cells: {
          WBS: '7.2',
          Task: 'Monitoring',
          Phase: 'Go Live',
          Lead: 'iRipple',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '7.1',
        },
        at: 46,
        days: 5,
      },
      {
        cells: {
          WBS: '8.1',
          Task: 'Client Endorsement to Support Team',
          Phase: 'Support Turnover',
          Lead: 'iRipple & Client',
          '% Done': 0,
          Status: 'Pending',
          Predecessor: '7.2',
        },
        at: 51,
        days: 1,
      },
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

/** The working day `n` working days after `start` (n = 0 is `start`, moved to Monday if it falls on a weekend). */
export function addWorkingDays(start: number, n: number) {
  let day = start
  while (isWeekend(day)) day++
  for (let left = n; left > 0; ) {
    day++
    if (!isWeekend(day)) left--
  }
  return day
}

/**
 * A template's starter rows as cells for a tracker made from it: column names become the new column ids, Choice
 * labels become option ids, and, when a start date is given, each row gets its Start and End from `at` and `days`.
 * Values for columns the tracker does not have are left out.
 */
export function templateRows(template: TrackerTemplate, columns: TrackerColumn[], startIso = '') {
  const byName = new Map(columns.map(column => [column.name.toLowerCase(), column]))
  const start = dayNumber(startIso)
  return (template.rows || []).map(row => {
    const cells: Record<string, Cell> = {}
    for (const [name, value] of Object.entries(row.cells)) {
      const column = byName.get(name.toLowerCase())
      if (!column) continue
      if (column.type === 'select') {
        const option = column.options?.find(item => item.label.toLowerCase() === String(value).toLowerCase())
        if (option) cells[column.id] = option.id
      } else if (column.type === 'number') cells[column.id] = Number(value)
      else cells[column.id] = String(value)
    }
    if (start !== null && template.schedule && row.at !== undefined) {
      const first = addWorkingDays(start, row.at)
      const last = addWorkingDays(first, Math.max(1, row.days || 1) - 1)
      const startColumn = byName.get(template.schedule.start.toLowerCase())
      const endColumn = byName.get(template.schedule.end.toLowerCase())
      if (startColumn) cells[startColumn.id] = isoOf(first)
      if (endColumn) cells[endColumn.id] = isoOf(last)
    }
    return { cells }
  })
}

/** The template's done column as tracker columns: the column with `autoDone` set to its Done and Pending options. */
export function withDoneColumn(template: TrackerTemplate, columns: TrackerColumn[]): TrackerColumn[] | null {
  const spec = template.doneColumn
  if (!spec) return null
  const target = columns.find(column => column.name.toLowerCase() === spec.column.toLowerCase())
  const option = (label?: string) =>
    label ? target?.options?.find(item => item.label.toLowerCase() === label.toLowerCase())?.id : undefined
  const done = option(spec.done)
  if (!target || !done) return null
  const undone = option(spec.undone)
  return columns.map(column =>
    column.id === target.id ? { ...column, autoDone: undone ? { done, undone } : { done } } : column,
  )
}
