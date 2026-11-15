/**
 * Jarvis in the Data explorer (write, change, fix and explain a query) and in Reports (build a whole report of SQL
 * widgets, with optional analyst notes). Queries run in the browser; only table and column names go to the AI, except
 * the results sent on purpose for analyst notes.
 */
import { Bot, Check, FilePlus2, Lightbulb, Loader2, Sparkles, Wand2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { requestJson } from '../../../shared/http'
import { Dialog } from '../../../shared/ui'
import type { Widget } from '../custom/reportModel'
import { VIEW_LABELS } from './DataExplorer'
import { type AssistMode, layoutReport, type PlannedWidget, type ReportPlan, resultText, schemaText } from './sqlAssist'
import type { TableInfo } from './explorerTables'
import { SqlError, type SqlResult } from './sqlEngine'

type Explorer = {
  catalog: TableInfo[]
  run: (sql: string, params: Record<string, string>) => Promise<SqlResult>
  loadTrackers: () => Promise<unknown>
}

export function askJarvis<T>(body: {
  mode: AssistMode
  question?: string
  sql?: string
  error?: string
  schema?: string
  results?: string
}) {
  return requestJson<T>('/api/assistant/sql', {
    method: 'POST',
    body,
    noStore: true,
    offline: 'The connection was interrupted. Check your connection and try again.',
    fallback: 'Jarvis is unavailable right now. Try again in a moment.',
  })
}

const problemOf = (failure: unknown) =>
  failure instanceof SqlError
    ? failure.message
    : failure instanceof Error
      ? failure.message
      : 'Something went wrong. Try again.'

/** The schema Jarvis writes against: every table, with tracker tables when trackers can be listed. */
async function schemaOf(explorer: Explorer) {
  await explorer.loadTrackers().catch(() => undefined)
  return schemaText(explorer.catalog)
}

/** The "Ask Jarvis" bar above the SQL editor. */
export function JarvisBar({
  explorer,
  sql,
  setSql,
  run,
  error,
}: {
  explorer: Explorer
  sql: string
  setSql: (sql: string) => void
  /** Runs a query in the editor; resolves with its error message, or '' when it ran. */
  run: (sql: string) => Promise<string>
  /** The editor's current error, for Fix. */
  error: string
}) {
  const [question, setQuestion] = useState('')
  const [change, setChange] = useState(false)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState('')
  const hasQuery = sql.trim().length > 0

  /** Puts Jarvis's query in the editor and runs it; when it fails, asks Jarvis to fix it once. */
  const apply = async (answer: { sql: string; note: string }) => {
    setSql(answer.sql)
    let failed = await run(answer.sql)
    if (!failed) return setNote(answer.note)
    setBusy('Fixing the query…')
    const fixed = await askJarvis<{ sql: string; note: string }>({
      mode: 'fix',
      sql: answer.sql,
      error: failed,
      schema: await schemaOf(explorer),
    })
    setSql(fixed.sql)
    failed = await run(fixed.sql)
    setNote(failed ? 'Jarvis could not make this query run. Try rewording the question.' : fixed.note)
  }
  const go = async (mode: AssistMode) => {
    setBusy(mode === 'explain' ? 'Reading the query…' : 'Writing the query…')
    setProblem('')
    setNote('')
    try {
      if (mode === 'explain') {
        const answer = await askJarvis<{ explanation: string }>({ mode, sql })
        setNote(answer.explanation)
      } else {
        const answer = await askJarvis<{ sql: string; note: string }>({
          mode,
          question: question.trim(),
          ...(mode === 'write' ? {} : { sql }),
          ...(mode === 'fix' ? { error } : {}),
          schema: await schemaOf(explorer),
        })
        await apply(answer)
        if (mode !== 'fix') setQuestion('')
      }
    } catch (failure) {
      setProblem(problemOf(failure))
    } finally {
      setBusy('')
    }
  }
  const ask = () => question.trim() && void go(change && hasQuery ? 'change' : 'write')

  return (
    <div className="dx-panel dx-jarvis">
      <form
        className="dx-jarvis-ask"
        onSubmit={event => {
          event.preventDefault()
          ask()
        }}
      >
        <Bot size={16} aria-hidden="true" />
        <input
          value={question}
          maxLength={1000}
          disabled={Boolean(busy)}
          aria-label="Ask Jarvis"
          placeholder={
            change && hasQuery
              ? 'What should change? e.g. only SM Prime, group by project, add a total'
              : 'Ask Jarvis: e.g. open tasks per client waiting on developer, oldest first'
          }
          onChange={event => setQuestion(event.target.value)}
        />
        {hasQuery && (
          <label className="dx-jarvis-change" title="Change the query in the editor instead of writing a new one">
            <input type="checkbox" checked={change} onChange={event => setChange(event.target.checked)} />
            Change current query
          </label>
        )}
        <button type="submit" className="crp-btn primary" disabled={Boolean(busy) || !question.trim()}>
          <Sparkles size={14} /> {change && hasQuery ? 'Change' : 'Write'}
        </button>
        <button
          type="button"
          className="crp-btn"
          disabled={Boolean(busy) || !hasQuery}
          onClick={() => void go('explain')}
        >
          <Lightbulb size={14} /> Explain
        </button>
        {error && (
          <button type="button" className="crp-btn" disabled={Boolean(busy)} onClick={() => void go('fix')}>
            <Wand2 size={14} /> Fix with Jarvis
          </button>
        )}
      </form>
      {busy && (
        <p className="dx-jarvis-note" role="status">
          <Loader2 size={13} className="dx-spin" aria-hidden="true" /> {busy}
        </p>
      )}
      {problem && <p className="dx-jarvis-note dx-jarvis-problem">{problem}</p>}
      {note && !busy && (
        <p className="dx-jarvis-note">
          <Bot size={13} aria-hidden="true" /> {note}
          <button type="button" className="crp-icon small" aria-label="Dismiss" onClick={() => setNote('')}>
            <X size={12} />
          </button>
        </p>
      )}
      <p className="dx-jarvis-privacy">Jarvis sees table and column names only. Your rows stay in your browser.</p>
    </div>
  )
}

type Built = PlannedWidget & { result?: SqlResult; problem?: string }

/** Reports: "Build with Jarvis". Plans a report, runs each query, and creates it when the person is happy. */
export function JarvisReportDialog({
  explorer,
  onCreate,
  onClose,
}: {
  explorer: Explorer
  onCreate: (name: string, widgets: Widget[]) => Promise<boolean>
  onClose: () => void
}) {
  const [request, setRequest] = useState('')
  const [plan, setPlan] = useState<ReportPlan | null>(null)
  const [built, setBuilt] = useState<Built[]>([])
  const [name, setName] = useState('')
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [problem, setProblem] = useState('')
  useEffect(() => {
    void explorer.loadTrackers().catch(() => undefined)
  }, [explorer.loadTrackers])

  /** Runs one planned query; a failing one goes back to Jarvis once to be fixed. */
  const runOne = async (item: PlannedWidget, schema: string): Promise<Built> => {
    try {
      return { ...item, result: await explorer.run(item.sql, {}) }
    } catch (failure) {
      try {
        const fixed = await askJarvis<{ sql: string }>({
          mode: 'fix',
          sql: item.sql,
          error: problemOf(failure),
          schema,
        })
        return { ...item, sql: fixed.sql, result: await explorer.run(fixed.sql, {}) }
      } catch (again) {
        return { ...item, problem: problemOf(again) }
      }
    }
  }
  const build = async () => {
    setBusy('Planning the report…')
    setProblem('')
    setNotes([])
    try {
      const schema = await schemaOf(explorer)
      const question = plan
        ? `${request.trim()}\n\nThe current plan, to change as asked:\n${plan.widgets.map(item => `- ${item.title} (${item.view}): ${item.sql}`).join('\n')}`
        : request.trim()
      const next = await askJarvis<ReportPlan>({ mode: 'report', question, schema })
      setPlan(next)
      setName(next.title)
      setBusy(`Running ${next.widgets.length} queries…`)
      const results: Built[] = []
      for (const item of next.widgets) results.push(await runOne(item, schema))
      setBuilt(results)
      setRequest('')
    } catch (failure) {
      setProblem(problemOf(failure))
    } finally {
      setBusy('')
    }
  }
  const working = built.filter(item => item.result)
  const writeNotes = async () => {
    setBusy('Reading the results…')
    setProblem('')
    try {
      const results = working
        .map(item => resultText(item.title, item.result as SqlResult))
        .join('\n\n')
        .slice(0, 60_000)
      const answer = await askJarvis<{ notes: string[] }>({ mode: 'notes', results })
      setNotes(answer.notes)
    } catch (failure) {
      setProblem(problemOf(failure))
    } finally {
      setBusy('')
    }
  }
  const create = async () => {
    setBusy('Creating the report…')
    const ok = await onCreate(name.trim() || 'Report by Jarvis', layoutReport(working, notes))
    setBusy('')
    if (ok) onClose()
  }

  return (
    <Dialog title="Build a report with Jarvis" eyebrow="Reports" size="wide" onClose={onClose} busy={Boolean(busy)}>
      <div className="dx-jarvis-report">
        <label className="crp-form-row">
          <span>{plan ? 'Change the plan' : 'What should the report show?'}</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={request}
            disabled={Boolean(busy)}
            placeholder={
              plan
                ? 'e.g. make the hours chart a pie, add overdue items by owner, drop the line chart'
                : 'e.g. Weekly status for SM Prime: open tasks by status, overdue items, hours per person this week, and rollout progress'
            }
            onChange={event => setRequest(event.target.value)}
          />
        </label>
        <div className="dx-jarvis-row">
          <span className="crp-muted">Jarvis sees table and column names only; the queries run in your browser.</span>
          <button
            type="button"
            className="crp-btn primary"
            disabled={Boolean(busy) || !request.trim()}
            onClick={() => void build()}
          >
            <Sparkles size={14} /> {plan ? 'Update the plan' : 'Plan the report'}
          </button>
        </div>
        {busy && (
          <p className="dx-jarvis-note" role="status">
            <Loader2 size={13} className="dx-spin" aria-hidden="true" /> {busy}
          </p>
        )}
        {problem && <p className="dx-jarvis-note dx-jarvis-problem">{problem}</p>}
        {plan && built.length > 0 && (
          <>
            <label className="crp-form-row">
              <span>Report name</span>
              <input value={name} maxLength={120} onChange={event => setName(event.target.value)} />
            </label>
            <ol className="dx-jarvis-plan">
              {built.map(item => (
                <li key={`${item.title}:${item.sql}`} className={item.problem ? 'failed' : ''}>
                  <strong>
                    {item.problem ? <X size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}{' '}
                    {item.title}
                  </strong>
                  <span>
                    {VIEW_LABELS[item.view]}
                    {item.result
                      ? ` · ${item.result.rows.length} row${item.result.rows.length === 1 ? '' : 's'}`
                      : ` · left out: ${item.problem}`}
                  </span>
                  <details>
                    <summary>SQL</summary>
                    <pre>{item.sql}</pre>
                  </details>
                </li>
              ))}
            </ol>
            {notes.length > 0 && (
              <div className="dx-jarvis-notes">
                <strong>What this shows</strong>
                <ul>
                  {notes.map(note => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      <div className="k-dialog-actions">
        {working.length > 0 && (
          <button
            type="button"
            className="crp-btn"
            disabled={Boolean(busy)}
            title="Sends the results of these queries (up to 40 rows each) to Jarvis to write findings"
            onClick={() => void writeNotes()}
          >
            <Lightbulb size={14} /> {notes.length ? 'Rewrite analyst notes' : 'Add analyst notes'}
          </button>
        )}
        <span className="crp-spacer" />
        <button type="button" className="crp-btn" onClick={onClose} disabled={Boolean(busy)}>
          Cancel
        </button>
        <button
          type="button"
          className="crp-btn primary"
          disabled={Boolean(busy) || !working.length}
          onClick={() => void create()}
        >
          <FilePlus2 size={14} /> Create report
        </button>
      </div>
    </Dialog>
  )
}
