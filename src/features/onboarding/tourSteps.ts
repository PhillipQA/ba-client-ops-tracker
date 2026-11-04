// The guided tour a person sees at first sign-in (and from Tour in the top bar): a welcome, then what to set up first,
// then where daily work happens. Steps are chosen for the person: Administrators set up the account, everyone connects
// their own Gmail and calendar, and only pages the person can open are shown.
import type { AppModule } from '../../shared/types'

export type TourView = 'action' | 'clients' | 'inbox' | 'items' | 'documents' | 'trackers' | 'reports' | 'settings'

export type TourStep = {
  id: string
  /** A short label for the part of the tour: Welcome, Account setup, Your setup, Daily work. */
  section: string
  title: string
  body: string
  /** Optional short list under the text. */
  points?: string[]
  /** What to light up (a CSS selector). No target, or one not on screen: a card in the middle of a dimmed page. */
  target?: string
  /** The page to open first. */
  view?: TourView
  /** Clicked before lighting up the target, e.g. a Settings tab, so the step shows what it talks about. */
  click?: string
}

export type TourContext = {
  isAdmin: boolean
  modules: readonly AppModule[] | readonly string[]
  /** Viewers read only: no steps about adding work. */
  canWrite: boolean
}

export const tourStorageKey = (organizationId = '', userId = '') => `ba.tour.done:${organizationId}:${userId}`

export function tourSteps(context: TourContext): TourStep[] {
  const has = (module: string) => context.modules.includes(module as AppModule)
  const steps: (TourStep | false)[] = [
    {
      id: 'welcome',
      section: 'Welcome',
      title: 'Welcome to BA Client Operations',
      body: 'One place for your clients, their tasks and emails, the documents you prepare for them, and the trackers and reports around that work. This short tour shows what to set up first and where everything lives.',
      points: [
        'About two minutes. Use Next and Back, or the arrow keys.',
        'Skip at any time. Replay it from Tour in the top bar.',
      ],
    },

    // --- Account setup: Administrators, once for everyone ---
    context.isAdmin &&
      has('settings') && {
        id: 'admin-settings',
        section: 'Account setup',
        title: 'Start in Settings',
        body: 'As an Administrator, you set up the account once and everyone uses it. Do this before inviting your team.',
        target: '[data-tour="nav-settings"]',
        view: 'settings',
      },
    context.isAdmin &&
      has('settings') && {
        id: 'admin-integrations',
        section: 'Account setup',
        title: 'Connect the account’s integrations',
        body: 'These connections are shared by the whole account. Each person then signs in with their own Google account where it applies.',
        points: [
          'Gmail: the Google OAuth app people use to connect their own mailbox to Work Hub.',
          'Google Calendar: lets people show their own calendar in the Action Center.',
          'Google Drive: the shared team Drive where email attachments and signed documents are filed.',
          'DocHub: the API key for sending documents for signature.',
          'Discord: optional, to capture mentions as Work Hub messages.',
        ],
        target: '#settings-section-integrations',
        view: 'settings',
        click: '#settings-tab-integrations',
      },
    context.isAdmin &&
      has('settings') && {
        id: 'admin-templates',
        section: 'Account setup',
        title: 'Upload the document templates',
        body: 'DRF, sign-off and other documents are generated from the account’s approved templates. Upload each one here; Document Creation uses them automatically.',
        target: '#settings-tab-templates',
        view: 'settings',
        click: '#settings-tab-templates',
      },
    context.isAdmin &&
      has('settings') && {
        id: 'admin-agents',
        section: 'Account setup',
        title: 'Turn on the AI agents (optional)',
        body: 'Add an AI provider key to use the AI BA Assistant and AI-enhanced COR extraction. Everything else works without it.',
        target: '#settings-tab-agents',
        view: 'settings',
        click: '#settings-tab-agents',
      },
    context.isAdmin && {
      id: 'admin-users',
      section: 'Account setup',
      title: 'Invite your team',
      body: 'Add each teammate, choose their role (Administrator, Contributor or Viewer) and the pages they can open.',
      target: '[data-tour="nav-users"]',
    },

    // --- Your setup: everyone ---
    has('inbox') && {
      id: 'gmail',
      section: 'Your setup',
      title: 'Connect your Gmail',
      body: 'Work Hub brings in email from the Gmail labels you choose, so a client’s request can become a task in one click and its attachments can be filed to Drive.',
      points: [
        'Open My integration settings and choose Connect Gmail.',
        'Pick the labels to bring in, save, then Sync Gmail.',
        'Discord, GitHub and GitLab can be connected here too.',
      ],
      target: '[data-tour="workhub-integrations"]',
      view: 'inbox',
    },
    has('action') && {
      id: 'calendar',
      section: 'Your setup',
      title: 'Connect your Google Calendar',
      body: 'See your own meetings next to your work. It stays private to you: read-only, never shared or sent to AI.',
      target: '[data-tour="calendar"]',
      view: 'action',
    },
    {
      id: 'profile',
      section: 'Your setup',
      title: 'Check your profile',
      body: 'Your name and email appear on documents and emails you send. Change your password and the look of the app here and in My Themes.',
      target: '[data-tour="profile"]',
    },

    // --- Daily work ---
    has('action') && {
      id: 'action',
      section: 'Daily work',
      title: 'Your day starts in the Action Center',
      body: 'What is due, overdue and waiting on you, with follow-ups and your calendar in one view.',
      target: '[data-tour="nav-action"]',
      view: 'action',
    },
    has('clients') && {
      id: 'clients',
      section: 'Daily work',
      title: 'Clients and projects',
      body: 'Every task, email, document and tracker belongs to a client, and optionally a project. Add your clients first.',
      target: '[data-tour="nav-clients"]',
    },
    context.canWrite &&
      (has('items') || has('inbox')) && {
        id: 'add-task',
        section: 'Daily work',
        title: 'Add tasks from anywhere',
        body: 'Add a task or subtask here, or turn an email into one from Work Hub. Open a task to log time, attach files, email from it and see its documents.',
        target: '[data-tour="add-task"]',
      },
    has('documents') && {
      id: 'documents',
      section: 'Daily work',
      title: 'Document Creation',
      body: 'Create a DRF from a client’s COR, plus BRD, FSD, test cases and sign-off documents. Read the task’s email beside the form, then send the document for signature through DocHub.',
      target: '[data-tour="nav-documents"]',
    },
    has('trackers') && {
      id: 'trackers',
      section: 'Daily work',
      title: 'Trackers',
      body: 'Sheet-like trackers and project timelines, optionally synced both ways with a Google Sheet, with rows that can become tasks.',
      target: '[data-tour="nav-trackers"]',
    },
    has('reports') && {
      id: 'reports',
      section: 'Daily work',
      title: 'Reports',
      body: 'Build dashboards from widgets, start from templates, and share them with your account. Data explorer answers anything else with SQL.',
      target: '[data-tour="nav-reports"]',
    },
    {
      id: 'refresh',
      section: 'Daily work',
      title: 'Staying up to date',
      body: 'Changes save automatically. Refresh now brings in teammates’ latest changes and syncs your connected integrations; the bell holds your notifications.',
      target: '[data-tour="refresh"]',
    },
    {
      id: 'done',
      section: 'Done',
      title: 'You’re all set',
      body: context.isAdmin
        ? 'Finish the account integrations and templates in Settings, invite your team, then connect your own Gmail and calendar.'
        : 'Connect your Gmail in Work Hub and your calendar in the Action Center, and you’re ready to work.',
      points: ['Replay this tour any time from Tour in the top bar.'],
      target: '[data-tour="tour"]',
    },
  ]
  return steps.filter((step): step is TourStep => Boolean(step))
}
