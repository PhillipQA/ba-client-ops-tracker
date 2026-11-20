// The guided tour a person sees at first sign-in (and from Tour in the top bar). After a welcome it walks the app in
// the order of a working day: Action Center (and making it your own) and calendar, Work Hub and what feeds it (Gmail, Discord, GitHub/GitLab),
// Trackers, Document Creation, Reports, the AI BA Assistant, and Settings last (where Administrators set up the
// account). Only pages the person can open are shown.
import type { AppModule } from '../../shared/types'

export type TourView =
  | 'action'
  | 'clients'
  | 'inbox'
  | 'items'
  | 'documents'
  | 'trackers'
  | 'reports'
  | 'ai'
  | 'settings'

export type TourStep = {
  id: string
  /** A short label for the part of the tour: Welcome, Your day, Work Hub, Your work, Settings. */
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
  /** Viewers read only: steps leave out adding and sending. */
  canWrite: boolean
}

export const tourStorageKey = (organizationId = '', userId = '') => `ba.tour.done:${organizationId}:${userId}`

export function tourSteps(context: TourContext): TourStep[] {
  const has = (module: string) => context.modules.includes(module as AppModule)
  const admin = context.isAdmin && has('settings')
  const steps: (TourStep | false)[] = [
    {
      id: 'welcome',
      section: 'Welcome',
      title: 'Welcome to BA Client Operations',
      body: 'One place for your clients’ tasks and emails, the trackers and documents you prepare for them, and the reports around that work. This short tour follows a working day, from the Action Center to Settings.',
      points: [
        'About two minutes. Use Next and Back, or the arrow keys.',
        'Skip at any time. Replay it from Tour in the top bar.',
      ],
    },

    // --- Your day ---
    has('action') && {
      id: 'action',
      section: 'Your day',
      title: 'Your day starts in the Action Center',
      body: 'What is due, overdue and waiting on you, with follow-ups and your calendar in one view.',
      target: '[data-tour="nav-action"]',
      view: 'action',
    },
    has('action') && {
      id: 'action-customize',
      section: 'Your day',
      title: 'Make the Action Center yours',
      body: 'Customize puts what you need on top. Your layout is yours alone; Administrators can set a starting layout for each role.',
      points: [
        'Drag widgets into order, make them half or full width, or hide them.',
        'Edit tiles: choose the counts at the top, rename and recolour them, or build your own count with filters.',
        ...(has('reports')
          ? ['Build your own widget with the Reports builder, or pin a chart from any saved report.']
          : []),
        'Add ready-made widgets: My time this week (40-hour target you can change), Follow-ups due, Recent tracker changes, Quick links and note.',
      ],
      target: '[data-tour="action-customize"]',
      view: 'action',
    },
    has('action') && {
      id: 'calendar',
      section: 'Your day',
      title: 'Connect your Google Calendar',
      body: 'See your own meetings next to your work. It stays private to you: read-only, never shared or sent to AI.',
      target: '[data-tour="calendar"]',
      view: 'action',
    },

    // --- Work Hub and what feeds it ---
    has('inbox') && {
      id: 'workhub',
      section: 'Work Hub',
      title: 'Work Hub: everything that comes in',
      body: context.canWrite
        ? 'Emails, Discord mentions and tickets arrive here, each in its own tab. Link a message to a task, or turn it into a new one.'
        : 'Emails, Discord mentions and tickets arrive here, each in its own tab.',
      points: [
        'Refresh now brings in the latest from everything you have connected.',
        'My integration settings is where you connect each source. They are yours alone.',
      ],
      target: '[data-tour="nav-inbox"]',
      view: 'inbox',
    },
    has('inbox') && {
      id: 'gmail',
      section: 'Work Hub',
      title: 'Gmail',
      body: 'Connect your own Gmail and choose the labels to bring in. A client’s request becomes a task in one click, and its attachments can be filed to the team Drive.',
      points: [
        'Open My integration settings and choose Connect Gmail.',
        'Pick the labels, save, then Sync Gmail.',
        ...(context.canWrite ? ['Allow sending email once to reply and send from a task.'] : []),
      ],
      target: '[data-tour="workhub-integrations"]',
      view: 'inbox',
      click: '[data-tour="workhub-tab-Gmail"]',
    },
    has('inbox') && {
      id: 'discord',
      section: 'Work Hub',
      title: 'Discord',
      body: 'Mentions of you, and your messages to the bot, are saved here so a request in chat is not lost.',
      points: [
        'Add your Discord user ID in My integration settings and tick Capture mentions of me.',
        'The bot only sees servers it has been added to, and never person-to-person DMs.',
      ],
      target: '[data-tour="workhub-tab-Discord"]',
      view: 'inbox',
      click: '[data-tour="workhub-tab-Discord"]',
    },
    has('inbox') && {
      id: 'gitlab',
      section: 'Work Hub',
      title: 'GitLab and GitHub',
      body: 'Bring in tickets with your own personal token and keep them next to the client’s other work.',
      points: [
        'GitLab brings the tickets you created, are assigned to, or commented on, from every project. Nothing else.',
        'Filter by project, label, milestone and due date; see priority, time spent and checklist progress.',
      ],
      target: '[data-tour="workhub-tab-GitHub"]',
      view: 'inbox',
      click: '[data-tour="workhub-tab-GitHub"]',
    },

    // --- Your work ---
    has('trackers') && {
      id: 'trackers',
      section: 'Your work',
      title: 'Trackers',
      body: 'Sheet-like trackers and project timelines, optionally synced both ways with a Google Sheet, with rows that can become tasks.',
      points: [
        'My folder holds the trackers you created, the ones on your projects, and the ones you were added to.',
        'Folders shows everyone’s; All trackers is the full list.',
        'Switch between Tile, List and Table.',
      ],
      target: '[data-tour="nav-trackers"]',
      view: 'trackers',
    },
    has('documents') && {
      id: 'documents',
      section: 'Your work',
      title: 'Document Creation',
      body: 'Create a DRF from a client’s COR, plus BRD, FSD, test cases and sign-off documents. Read the task’s email beside the form, then send the document for signature through DocHub.',
      points: [
        'Document history shows who has signed.',
        ...(context.canWrite
          ? ['Void a request that is not fully signed, or remove a document that was deleted in DocHub.']
          : []),
      ],
      target: '[data-tour="nav-documents"]',
      view: 'documents',
    },
    has('reports') && {
      id: 'reports',
      section: 'Your work',
      title: 'Reports',
      body: 'Build dashboards from widgets, start from templates, and share them with your account. Data explorer answers anything else with SQL.',
      ...(has('action')
        ? { points: ['Pin any widget of a saved report to your Action Center; it follows the report.'] }
        : {}),
      target: '[data-tour="nav-reports"]',
      view: 'reports',
    },
    has('reports') &&
      has('ai') &&
      context.canWrite && {
        id: 'reports-jarvis',
        section: 'Your work',
        title: 'Jarvis in Reports',
        body: 'Ask in plain words and Jarvis does the data analyst’s work. It only sees table and column names; your rows stay in your browser.',
        points: [
          'Build with Jarvis: describe a report and get headline numbers, charts and tables you can change in words, then keep.',
          'Add analyst notes for a short “What this shows” summary of the results.',
          'In Data explorer, Ask Jarvis writes, changes, explains or fixes a SQL query.',
        ],
        target: '[data-tour="reports-jarvis"]',
        view: 'reports',
      },
    has('ai') && {
      id: 'ai',
      section: 'Your work',
      title: 'AI BA Assistant',
      body: 'Ask about the tasks and trackers you can open, in plain words. It only knows what you are allowed to see.',
      points: context.canWrite
        ? [
            'Link an email to a task and open its DRF or sign-off, with fields drafted from the email.',
            'Draft a tracker from data you give it.',
            'Nothing is linked or created until you approve.',
            ...(has('reports') ? ['In Reports, Jarvis also writes SQL and builds whole reports.'] : []),
          ]
        : ['Summarize a tracker, or ask what is due or overdue.'],
      target: '[data-tour="nav-ai"]',
      view: 'ai',
    },

    // --- Settings: last, and mostly for Administrators, who set up the account once for everyone ---
    has('settings') && {
      id: 'settings',
      section: 'Settings',
      title: 'Settings',
      body: admin
        ? 'As an Administrator, you set up the account once and everyone uses it. Do this before inviting your team.'
        : 'How the account is set up: its integrations, templates and workflow.',
      target: '[data-tour="nav-settings"]',
      view: 'settings',
    },
    admin && {
      id: 'admin-integrations',
      section: 'Settings',
      title: 'Connect the account’s integrations',
      body: 'These connections are shared by the whole account. Each person then signs in with their own Google account where it applies.',
      points: [
        'Seeds: the source of clients, projects and tasks, and where time logs are sent.',
        'Gmail and Google Calendar: what people use to connect their own mailbox and calendar.',
        'Google Drive: the shared team Drive where email attachments and signed documents are filed.',
        'DocHub: the API key for sending documents for signature.',
        'Discord: optional, to capture mentions as Work Hub messages.',
      ],
      target: '#settings-section-integrations',
      view: 'settings',
      click: '#settings-tab-integrations',
    },
    admin && {
      id: 'admin-templates',
      section: 'Settings',
      title: 'Upload the document templates',
      body: 'DRF, sign-off and other documents are generated from the account’s approved templates. Upload each one here; Document Creation uses them automatically.',
      target: '#settings-tab-templates',
      view: 'settings',
      click: '#settings-tab-templates',
    },
    admin && {
      id: 'admin-agents',
      section: 'Settings',
      title: 'Turn on the AI agents (optional)',
      body: 'Add an AI provider key to use the AI BA Assistant and AI-enhanced COR extraction. Everything else works without it.',
      target: '#settings-tab-agents',
      view: 'settings',
      click: '#settings-tab-agents',
    },
    context.isAdmin && {
      id: 'admin-users',
      section: 'Settings',
      title: 'Invite your team',
      body: 'Add each teammate with their job roles, which decide the pages they can open. They can sign in with Continue with Google or a password.',
      points: [
        'Use each person’s Seeds email: once Seeds is on, only active Seeds employees can sign in.',
        'Someone Seeds does not list can sign in with a password only if Internal Admin allows it for them.',
      ],
      target: '[data-tour="nav-users"]',
    },
    {
      id: 'done',
      section: 'Done',
      title: 'You’re all set',
      body: context.isAdmin
        ? 'Finish the account integrations and templates in Settings, invite your team, then connect your own Gmail and calendar.'
        : 'Connect your calendar in the Action Center and your Gmail in Work Hub, and you’re ready to work.',
      points: ['Replay this tour any time from Tour in the top bar.'],
      target: '[data-tour="tour"]',
    },
  ]
  return steps.filter((step): step is TourStep => Boolean(step))
}
