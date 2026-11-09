import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'

export type ClientChoice = { id: string; name: string; seedsId?: string }
type Extra = { value: string; label: string; hint?: string; depth?: number; group?: string }
/**
 * One choice in a SearchSelect: `hint` is shown small beside it and is searched too; `depth` 1 marks a subtask;
 * `group` puts a heading (such as "From Seeds") above the first choice of each group. Keep a group's choices together.
 */
export type SearchChoice = Extra

type Props = {
  clients: readonly ClientChoice[]
  /** The chosen client id ('' or an extra option's value). Leave out with `defaultValue` for a form field. */
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  /** Choices shown above the clients, such as “All clients” or “No client”. */
  extra?: Extra[]
  name?: string
  disabled?: boolean
  required?: boolean
  placeholder?: string
  'aria-label'?: string
  className?: string
}

const sortByName = (list: readonly ClientChoice[]) =>
  [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))

/**
 * A client field you type into: it lists clients A to Z and narrows them as you type, like the email recipient box.
 * Arrow keys move, Enter picks, Escape goes back to the last choice. It submits the client id under `name` in forms.
 * Once Seeds is on (some clients come from Seeds), they are grouped: From Seeds first, then Before Seeds.
 */
export default function ClientSelect({ clients, extra = [], placeholder = 'Type a client name', ...props }: Props) {
  const choices = useMemo(() => {
    const sorted = sortByName(clients)
    const choice = (client: ClientChoice, group?: string) => ({ value: client.id, label: client.name, group })
    if (!sorted.some(client => client.seedsId)) return [...extra, ...sorted.map(client => choice(client))]
    return [
      ...extra,
      ...sorted.filter(client => client.seedsId).map(client => choice(client, 'From Seeds')),
      ...sorted.filter(client => !client.seedsId).map(client => choice(client, 'Before Seeds')),
    ]
  }, [clients, extra])
  return <SearchSelect {...props} choices={choices} placeholder={placeholder} empty="No client matches" />
}

type SearchProps = Omit<Props, 'clients' | 'extra'> & { choices: SearchChoice[]; empty?: string }

/** The type-to-search field behind ClientSelect, for any list: choices keep their order; the first ones with an empty value are hints. */
export function SearchSelect({
  choices,
  value,
  defaultValue = '',
  onChange,
  name,
  disabled,
  required,
  placeholder = 'Type to search',
  className = '',
  empty = 'Nothing matches',
  ...rest
}: SearchProps) {
  const extra = useMemo(() => choices.filter(choice => choice.value === ''), [choices])
  const [inner, setInner] = useState(defaultValue)
  const current = value ?? inner
  const chosen = choices.find(choice => choice.value === current)
  // An empty choice such as “All clients” shows as the field's hint, so a required field stays empty until a client is chosen.
  const blank = extra.find(choice => choice.value === '')
  const chosenLabel = current === '' ? '' : chosen ? chosen.label : 'Unknown client'
  const [text, setText] = useState(chosenLabel)
  const [typed, setTyped] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [place, setPlace] = useState<CSSProperties>({})
  const [host, setHost] = useState<HTMLElement | null>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) setText(chosenLabel)
  }, [chosenLabel, open])

  const shown = useMemo(() => {
    const words = typed ? text.toLowerCase().split(/\s+/).filter(Boolean) : []
    if (!words.length) return choices
    const name = (choice: Extra) => choice.label.toLowerCase()
    const hits = choices.filter(choice =>
      words.every(word => `${choice.label} ${choice.hint || ''}`.toLowerCase().includes(word)),
    )
    // Names that start with what was typed come first, then the rest, each A to Z; groups stay together.
    const ranked = [
      ...hits.filter(choice => name(choice).startsWith(words[0])),
      ...hits.filter(choice => !name(choice).startsWith(words[0])),
    ]
    const groups = [...new Set(choices.map(choice => choice.group || ''))]
    return ranked.sort((a, b) => groups.indexOf(a.group || '') - groups.indexOf(b.group || ''))
  }, [choices, text, typed])

  // The list floats above dialogs and scrolling panels, so it follows the field on screen.
  useLayoutEffect(() => {
    if (!open) return
    const follow = () => {
      const field = input.current,
        el = list.current
      const box = field?.getBoundingClientRect()
      if (!field || !box) return
      // Inside a dialog that is moved by a transform, `fixed` is measured from the dialog, not the screen. Find where
      // 0,0 really is by placing the list there for a moment, then place it relative to that.
      let originX = 0,
        originY = 0,
        natural = Math.max(120, (shown.length + new Set(shown.map(choice => choice.group || '')).size) * 34 + 8)
      if (el) {
        // Measuring drops the height limit for a moment, which resets the list's scroll: put it back after.
        const keep = el.getAttribute('style') || ''
        const scrolled = el.scrollTop
        el.style.cssText = 'position:fixed;left:0;top:0;bottom:auto;max-height:none;visibility:hidden'
        const probe = el.getBoundingClientRect()
        originX = probe.left
        originY = probe.top
        natural = probe.height
        el.setAttribute('style', keep)
        el.scrollTop = scrolled
      }
      const below = window.innerHeight - box.bottom - 12,
        above = box.top - 12
      const up = below < Math.min(natural, 280) && above > below
      const maxHeight = Math.max(80, Math.min(280, up ? above : below))
      const height = Math.min(natural, maxHeight)
      const width = Math.min(Math.max(box.width, 220), window.innerWidth - 16)
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
      const top = up ? box.top - 4 - height : box.bottom + 4
      // The list is drawn outside the field's own containers, so it carries the field's colours: the theme
      // variables are read where the field is.
      const look = getComputedStyle(field)
      const token = (name: string, fallback: string) => look.getPropertyValue(name).trim() || fallback
      const themed = Boolean(look.getPropertyValue('--ui-surface').trim())
      setPlace({
        position: 'fixed',
        left: left - originX,
        top: top - originY,
        width,
        maxHeight,
        background: themed ? token('--ui-surface', '#ffffff') : '#20252c',
        color: themed ? token('--ui-text', '#1f2937') : '#eef2f7',
        borderColor: themed ? token('--ui-border', '#d0d5dd') : '#3a4350',
        fontFamily: look.fontFamily,
        ['--combo-accent' as string]: token('--ui-accent', '#4f6bed'),
      })
    }
    // A modal dialog sits in the browser's top layer, so the list must be inside it to show and take clicks.
    setHost(input.current?.closest<HTMLElement>('dialog[open]') || document.body)
    follow()
    // Scrolling the list itself does not move the field: re-measuring then would jump the list back to the top, so
    // the list could not be scrolled at all.
    const scrolled = (event: Event) => {
      if (list.current && event.target instanceof Node && list.current.contains(event.target)) return
      follow()
    }
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [open, shown.length, host])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (choice: Extra) => {
    if (value === undefined) setInner(choice.value)
    if (choice.value !== current) onChange?.(choice.value)
    setText(choice.value === '' ? '' : choice.label)
    setTyped(false)
    setOpen(false)
  }
  const revert = () => {
    setText(chosenLabel)
    setTyped(false)
    setOpen(false)
  }
  const settle = () => {
    // Leaving the field keeps an exact or single match, and otherwise goes back to the last choice.
    if (!typed) return revert()
    const exact = choices.find(choice => choice.label.toLowerCase() === text.trim().toLowerCase())
    if (exact) return pick(exact)
    if (!text.trim() && blank) return pick(blank)
    if (shown.length === 1) return pick(shown[0])
    revert()
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(
          Math.max(
            0,
            shown.findIndex(choice => choice.value === current),
          ),
        )
        return
      }
      setActive(at => Math.max(0, Math.min(shown.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter') {
      if (open && shown[active]) {
        event.preventDefault()
        pick(shown[active])
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault()
        event.stopPropagation()
        revert()
      }
    } else if (event.key === 'Tab') {
      if (open) settle()
    }
  }

  return (
    <span className={`client-combo${className ? ` ${className}` : ''}`}>
      <input
        ref={input}
        className="client-combo-input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
        aria-label={rest['aria-label']}
        value={text}
        placeholder={blank?.label || placeholder}
        disabled={disabled}
        required={required && !current}
        autoComplete="off"
        spellCheck={false}
        onFocus={event => {
          event.currentTarget.select()
          setTyped(false)
          setOpen(true)
          setActive(
            Math.max(
              0,
              choices.findIndex(choice => choice.value === current),
            ),
          )
        }}
        onClick={() => {
          if (!open) setOpen(true)
        }}
        onChange={event => {
          setText(event.target.value)
          setTyped(true)
          setOpen(true)
          setActive(0)
        }}
        onBlur={settle}
        onKeyDown={keys}
      />
      {name && <input type="hidden" name={name} value={current} disabled={disabled} />}
      {open &&
        !disabled &&
        host &&
        createPortal(
          <ul ref={list} id={listId} role="listbox" className="client-combo-list" style={place}>
            {shown.map((choice, at) => [
              choice.group && choice.group !== shown[at - 1]?.group ? (
                <li key={`group:${choice.group}:${at}`} className="client-combo-group" role="presentation">
                  {choice.group}
                </li>
              ) : null,
              <li
                key={`${choice.value || '__blank'}:${at}`}
                id={`${listId}-${at}`}
                role="option"
                aria-selected={choice.value === current}
                data-active={at === active}
                className={`${choice.value === current ? 'chosen' : ''}${extra.includes(choice) ? ' extra' : ''}${choice.depth ? ' sub' : ''}`}
                onMouseDown={event => {
                  event.preventDefault()
                  pick(choice)
                }}
                onMouseEnter={() => setActive(at)}
              >
                {choice.depth ? (
                  <span className="client-combo-branch" aria-hidden="true">
                    ↳{' '}
                  </span>
                ) : null}
                {choice.label}
                {choice.hint && <small>{choice.hint}</small>}
              </li>,
            ])}
            {!shown.length && (
              <li className="client-combo-empty" role="presentation">
                {empty} “{text.trim()}”
              </li>
            )}
          </ul>,
          host,
        )}
    </span>
  )
}
