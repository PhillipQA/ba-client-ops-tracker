import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { emailForName, matchPeople } from '../../features/email/emailSuggest'
import { searchContacts } from '../contactSearch'
import type { Suggestion } from './RecipientInput'
import { SuggestionList, suggestionStatus } from './SuggestionList'
import '../../features/email/emailComposer.css'

/**
 * A name field that knows people's email addresses, for signatories in Document Creation.
 *  - While typing, people with a matching name are suggested. Choosing one fills in the name and the email.
 *  - When a typed name is exactly one known person and the email is still empty, the email is filled in.
 *  - If nobody matches, nothing is filled in. An email filled in this way is cleared again if the name is changed to someone else.
 * The email is never taken from a guess: a name with two different addresses is left for the person to choose.
 */
type Props = {
  label: string
  value: string
  email: string
  onName: (name: string) => void
  onEmail: (email: string) => void
  /** People already known in the browser (clients, teammates). */
  local: Suggestion[]
  maxLength?: number
  placeholder?: string
}

const DELAY_MS = 180
const SHOWN = 8
let seedsDirectoryCache: { expiresAt: number; people: Suggestion[] } | undefined
let seedsDirectoryRequest: Promise<Suggestion[]> | undefined

function loadSeedsDirectory(): Promise<Suggestion[]> {
  if (seedsDirectoryCache && seedsDirectoryCache.expiresAt > Date.now())
    return Promise.resolve(seedsDirectoryCache.people)
  if (!seedsDirectoryRequest) {
    seedsDirectoryRequest = fetch('/api/seeds/people', { credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) return []
        const payload = (await response.json().catch(() => ({}))) as { people?: Suggestion[] }
        return Array.isArray(payload.people)
          ? payload.people.filter(
              person => person && typeof person.name === 'string' && typeof person.email === 'string',
            )
          : []
      })
      .catch(() => [])
      .then(people => {
        seedsDirectoryCache = { expiresAt: Date.now() + 5 * 60_000, people }
        return people
      })
      .finally(() => {
        seedsDirectoryRequest = undefined
      })
  }
  return seedsDirectoryRequest
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function PersonNameInput({ label, value, email, onName, onEmail, local, maxLength, placeholder }: Props) {
  const id = useId(),
    listId = `${id}-list`
  const [remote, setRemote] = useState<Suggestion[]>([])
  const [directory, setDirectory] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0),
    [navigated, setNavigated] = useState(false),
    [focused, setFocused] = useState(false),
    [closed, setClosed] = useState(false)
  const [filled, setFilled] = useState('')
  const known = useMemo(() => {
    const seen = new Set<string>()
    return [...local, ...directory].filter(person => {
      const email = person.email.trim().toLowerCase()
      if (!email || seen.has(email)) return false
      seen.add(email)
      return true
    })
  }, [local, directory])
  // The email this field put in, so a change of name can take it out again and a hand-typed email is never touched.
  const auto = useRef('')
  const latest = useRef({ value, email, local: known, onEmail })
  latest.current = { value, email, local: known, onEmail }

  useEffect(() => {
    let alive = true
    loadSeedsDirectory().then(people => {
      if (alive) setDirectory(people)
    })
    return () => {
      alive = false
    }
  }, [])
  const run = useRef(0),
    mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const query = value.trim().length >= 2 ? value.trim() : ''
  useEffect(() => {
    if (!query) {
      setRemote([])
      return
    }
    const mine = ++run.current,
      controller = new AbortController()
    const timer = setTimeout(() => {
      searchContacts(query, controller.signal).then(
        result => {
          if (mine === run.current) setRemote(result.people)
        },
        () => {
          /* Suggestions are optional. */
        },
      )
    }, DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const suggestions = useMemo(() => {
    if (!query) return []
    const emailed = matchPeople(remote, query, { limit: SHOWN, keepOrder: true })
    return matchPeople([...emailed, ...matchPeople(known, query, { limit: SHOWN })], query, {
      limit: SHOWN,
      keepOrder: true,
    })
  }, [query, remote, known])

  const open = focused && !closed && suggestions.length > 0
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1))
  const optionId = (index: number) => `${id}-option-${index}`
  const stillFilled = Boolean(filled) && sameAddress(email, filled)

  const fill = (address: string) => {
    auto.current = address
    setFilled(address)
    latest.current.onEmail(address)
  }
  const forget = () => {
    auto.current = ''
    setFilled('')
  }

  const change = (next: string) => {
    onName(next)
    setActive(0)
    setNavigated(false)
    setClosed(false)
    // The old name's email no longer applies. Anything the person typed themselves is left alone.
    if (auto.current && sameAddress(latest.current.email, auto.current)) {
      latest.current.onEmail('')
      forget()
    }
  }
  const choose = (person: Suggestion) => {
    if (person.name) onName(person.name)
    fill(person.email)
    setClosed(true)
    setActive(0)
    setNavigated(false)
  }
  // Leaving the field with a full name and no email: look the name up once, and only fill in a clear single match.
  const lookUp = () => {
    const typed = latest.current.value.trim()
    if (latest.current.email.trim() || typed.length < 3) return
    const settle = (people: Suggestion[]) => {
      const now = latest.current
      if (!mounted.current || now.value.trim() !== typed || now.email.trim()) return
      const found = emailForName([...people, ...now.local], typed)
      if (found) fill(found.email)
    }
    const known = emailForName(latest.current.local, typed)
    if (known) {
      settle([])
      return
    }
    searchContacts(typed).then(
      result => settle(result.people),
      () => {},
    )
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setClosed(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setNavigated(true)
      setActive((highlighted + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
      return
    }
    // Enter takes a suggestion only when one was picked with the arrow keys, so typing a name and pressing Enter never swaps in somebody else.
    if (event.key === 'Enter' && navigated) {
      event.preventDefault()
      choose(suggestions[highlighted])
    }
  }

  return (
    <div className="person-field">
      <div className="person-anchor">
        <label>
          {label}
          <input
            id={id}
            value={value}
            maxLength={maxLength}
            placeholder={placeholder}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? optionId(highlighted) : undefined}
            onChange={event => change(event.target.value)}
            onKeyDown={keys}
            onFocus={() => {
              setFocused(true)
              setClosed(false)
            }}
            onBlur={() => {
              setFocused(false)
              lookUp()
            }}
          />
        </label>
        {open && (
          <SuggestionList
            id={listId}
            label={label}
            people={suggestions}
            highlighted={highlighted}
            optionId={optionId}
            onChoose={choose}
            onHover={setActive}
          />
        )}
      </div>
      {stillFilled && (
        <small className="person-note" role="status">
          Email filled in from your contacts. Check that it is right.
        </small>
      )}
      <span className="email-sr" role="status" aria-live="polite">
        {open ? suggestionStatus(suggestions.length) : ''}
      </span>
    </div>
  )
}
