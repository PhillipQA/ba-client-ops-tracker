import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { matchPeople } from './emailSuggest'
import { applyMention, mentionName, mentionToken, type Mention } from './emailMentions'
import { SuggestionList, suggestionStatus } from '../../shared/ui/SuggestionList'
import type { Suggestion } from '../../shared/ui/RecipientInput'

const DELAY_MS = 180
const SHOWN = 8

type Props = {
  value: string
  onChange: (value: string) => void
  maxLength: number
  /** People known in the browser (clients, teammates). */
  local: Suggestion[]
  /** People from the server for what was typed. Suggestions are a convenience: failures are ignored. */
  search: (query: string, signal: AbortSignal) => Promise<{ people: Suggestion[] }>
  /** A person was mentioned: add them to the recipients. */
  onMention: (mention: Mention) => void
}

/** The message box: typing @ and a few letters suggests people, like Outlook. */
export function MentionTextarea({ value, onChange, maxLength, local, search, onMention }: Props) {
  const box = useRef<HTMLTextAreaElement>(null),
    id = useId(),
    listId = `${id}-list`
  const [token, setToken] = useState<{ start: number; end: number; text: string } | null>(null)
  const [remote, setRemote] = useState<Suggestion[]>([])
  const [active, setActive] = useState(0),
    [closed, setClosed] = useState(false)
  const searchRef = useRef(search)
  searchRef.current = search

  useEffect(() => {
    if (!token?.text) {
      setRemote([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchRef
        .current(token.text, controller.signal)
        .then(result => setRemote(Array.isArray(result.people) ? result.people : []))
        .catch(() => {})
    }, DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [token?.text])

  const suggestions = useMemo(() => {
    if (!token) return []
    // "@" alone shows teammates and clients; typing narrows to anyone matching, people emailed before first.
    if (!token.text) return local.slice(0, SHOWN)
    const emailed = matchPeople(remote, token.text, { limit: SHOWN, keepOrder: true })
    return matchPeople([...emailed, ...matchPeople(local, token.text, { limit: SHOWN })], token.text, {
      limit: SHOWN,
      keepOrder: true,
    })
  }, [token, remote, local])
  const open = Boolean(token) && !closed && suggestions.length > 0
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1))
  const optionId = (index: number) => `${id}-option-${index}`

  const read = (next: string, caret: number | null) => {
    setToken(mentionToken(next, caret ?? next.length))
    setActive(0)
    setClosed(false)
  }
  const choose = (person: Suggestion) => {
    if (!token) return
    const name = mentionName(person.name, person.email)
    const result = applyMention(value, token, name)
    if (result.value.length > maxLength) return
    onChange(result.value)
    onMention({ name, email: person.email })
    setToken(null)
    setRemote([])
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(result.caret, result.caret)
    })
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setClosed(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((highlighted + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length)
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault()
      choose(suggestions[highlighted])
    }
  }

  return (
    <span className="email-combo">
      <textarea
        ref={box}
        rows={9}
        value={value}
        maxLength={maxLength}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(highlighted) : undefined}
        aria-describedby={`${id}-hint`}
        onChange={event => {
          onChange(event.target.value)
          read(event.target.value, event.target.selectionStart)
        }}
        onKeyDown={keys}
        onKeyUp={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            read(event.currentTarget.value, event.currentTarget.selectionStart)
        }}
        onClick={event => read(event.currentTarget.value, event.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setToken(null), 150)}
      />
      {open && (
        <SuggestionList
          id={listId}
          label="Mention"
          people={suggestions}
          highlighted={highlighted}
          optionId={optionId}
          onChoose={choose}
          onHover={setActive}
        />
      )}
      <small id={`${id}-hint`} className="email-mention-hint">
        Type @ and a name to mention someone: they are added to To, and their name is a link in the email.
      </small>
      <span className="email-sr" role="status" aria-live="polite">
        {open ? suggestionStatus(suggestions.length) : ''}
      </span>
    </span>
  )
}
