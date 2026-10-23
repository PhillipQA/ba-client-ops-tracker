import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { isValidEmail, splitAddresses } from './emailCompose'
import { applySuggestion, currentToken, matchPeople, type RankedPerson } from './emailSuggest'
import { SuggestionList, suggestionStatus } from './SuggestionList'

/**
 * A To, Cc or Bcc line that suggests people while you type, like Gmail: people you have emailed, people who emailed you,
 * your clients and your teammates. The line stays plain text ("ana@acme.com, kim@acme.com"), so pasting still works.
 */
export type Suggestion = RankedPerson & { hint?: string }

type Props = {
  label: string
  value: string
  onChange: (value: string) => void
  /** People already known in the browser (clients, teammates). */
  local: Suggestion[]
  /** Addresses already on any recipient line, lower-cased, so nobody is suggested twice. */
  taken: string[]
  /** People from the server for what was typed. May reject or return nothing: suggestions are only a convenience. */
  search: (query: string, signal: AbortSignal) => Promise<{ people: Suggestion[]; partial?: boolean }>
  placeholder?: string
  children?: ReactNode
}

const DELAY_MS = 180
const RETRY_MS = 1500
const SHOWN = 8

export function RecipientInput({ label, value, onChange, local, taken, search, placeholder, children }: Props) {
  const input = useRef<HTMLInputElement>(null), id = useId(), listId = `${id}-list`
  const [token, setToken] = useState<{ start: number; end: number; text: string }>({ start: 0, end: 0, text: '' })
  const [remote, setRemote] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0), [navigated, setNavigated] = useState(false), [focused, setFocused] = useState(false), [closed, setClosed] = useState(false)
  const latest = useRef(0), searchRef = useRef(search)
  searchRef.current = search

  // Ask the server a moment after typing stops. Older answers are dropped, and a first build still running is asked again once.
  useEffect(() => {
    if (!token.text) { setRemote([]); return }
    const run = ++latest.current, controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    const ask = async (again: boolean) => {
      try {
        const result = await searchRef.current(token.text, controller.signal)
        if (run !== latest.current) return
        setRemote(Array.isArray(result.people) ? result.people : [])
        if (result.partial && again) retry = setTimeout(() => { void ask(false) }, RETRY_MS)
      } catch { /* Suggestions are optional. */ }
    }
    const timer = setTimeout(() => { void ask(true) }, DELAY_MS)
    return () => { clearTimeout(timer); if (retry) clearTimeout(retry); controller.abort() }
  }, [token.text])

  const suggestions = useMemo(() => {
    if (!token.text) return []
    const typed = token.text.toLowerCase()
    const exclude = taken.filter(address => address !== typed)
    // People you have emailed come first, in the server's order, then clients and teammates. Everyone is shown once.
    const emailed = matchPeople(remote, token.text, { exclude, limit: SHOWN, keepOrder: true })
    return matchPeople([...emailed, ...matchPeople(local, token.text, { exclude, limit: SHOWN })], token.text, { exclude, limit: SHOWN, keepOrder: true })
  }, [token.text, remote, local, taken])

  const open = focused && !closed && suggestions.length > 0
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1))
  const optionId = (index: number) => `${id}-option-${index}`

  const read = (next: string, caret: number | null) => {
    setToken(currentToken(next, caret ?? next.length)); setActive(0); setNavigated(false); setClosed(false)
  }
  const choose = (person: Suggestion) => {
    const result = applySuggestion(value, token, person.email)
    onChange(result.value)
    setToken({ start: result.caret, end: result.caret, text: '' }); setRemote([]); setActive(0); setNavigated(false)
    // Put the cursor after the new address once React has written the new value.
    requestAnimationFrame(() => { input.current?.setSelectionRange(result.caret, result.caret) })
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosed(true); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setNavigated(true)
      setActive((highlighted + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
      return
    }
    // Enter or Tab takes the highlighted person, unless a complete address was typed and nobody was picked on purpose.
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && (navigated || !isValidEmail(token.text))) {
      event.preventDefault(); choose(suggestions[highlighted])
    }
  }

  return <div className="email-field">
    <label htmlFor={id}>{label}</label>
    <span className="email-combo">
      <input id={id} ref={input} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open ? optionId(highlighted) : undefined}
        onChange={event => { onChange(event.target.value); read(event.target.value, event.target.selectionStart) }}
        onKeyDown={keys}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) read(event.currentTarget.value, event.currentTarget.selectionStart) }}
        onClick={event => read(event.currentTarget.value, event.currentTarget.selectionStart)}
        onFocus={event => { setFocused(true); read(event.currentTarget.value, event.currentTarget.selectionStart) }}
        onBlur={() => setFocused(false)} />
      {open && <SuggestionList id={listId} label={label} people={suggestions} highlighted={highlighted} optionId={optionId} onChoose={choose} onHover={setActive} />}
      <span className="email-sr" role="status" aria-live="polite">{open ? suggestionStatus(suggestions.length) : ''}</span>
    </span>
    {children}
  </div>
}

/** The addresses currently on a line, lower-cased, for hiding people already added. */
export const addressesOn = (value: string) => splitAddresses(value).map(address => address.toLowerCase())
