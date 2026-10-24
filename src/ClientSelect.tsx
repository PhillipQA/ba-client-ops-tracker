import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'

export type ClientChoice = { id: string; name: string }
type Extra = { value: string; label: string }

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

const sortByName = (list: readonly ClientChoice[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))

/**
 * A client field you type into: it lists clients A to Z and narrows them as you type, like the email recipient box.
 * Arrow keys move, Enter picks, Escape goes back to the last choice. It submits the client id under `name` in forms.
 */
export default function ClientSelect({ clients, value, defaultValue = '', onChange, extra = [], name, disabled, required, placeholder = 'Type a client name', className = '', ...rest }: Props) {
  const [inner, setInner] = useState(defaultValue)
  const current = value ?? inner
  const choices = useMemo(() => [...extra, ...sortByName(clients).map(client => ({ value: client.id, label: client.name }))], [clients, extra])
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
  const listId = useId()

  useEffect(() => { if (!open) setText(chosenLabel) }, [chosenLabel, open])

  const shown = useMemo(() => {
    const words = typed ? text.toLowerCase().split(/\s+/).filter(Boolean) : []
    if (!words.length) return choices
    const name = (choice: Extra) => choice.label.toLowerCase()
    const hits = choices.filter(choice => words.every(word => name(choice).includes(word)))
    // Names that start with what was typed come first, then the rest, each A to Z.
    return [...hits.filter(choice => name(choice).startsWith(words[0])), ...hits.filter(choice => !name(choice).startsWith(words[0]))]
  }, [choices, text, typed])

  // The list floats above dialogs and scrolling panels, so it follows the field on screen.
  useLayoutEffect(() => {
    if (!open) return
    const follow = () => {
      const box = input.current?.getBoundingClientRect()
      if (!box) return
      const below = window.innerHeight - box.bottom, height = Math.min(280, Math.max(120, shown.length * 34 + 8))
      const up = below < height && box.top > below
      setPlace({ position: 'fixed', left: box.left, width: Math.max(box.width, 220), ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }), maxHeight: Math.min(280, up ? box.top - 12 : below - 12) })
    }
    follow()
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true) }
  }, [open, shown.length])
  useEffect(() => { list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const pick = (choice: Extra) => {
    if (value === undefined) setInner(choice.value)
    if (choice.value !== current) onChange?.(choice.value)
    setText(choice.label); setTyped(false); setOpen(false)
  }
  const revert = () => { setText(chosenLabel); setTyped(false); setOpen(false) }
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
      if (!open) { setOpen(true); setActive(Math.max(0, shown.findIndex(choice => choice.value === current))); return }
      setActive(at => Math.max(0, Math.min(shown.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter') {
      if (open && shown[active]) { event.preventDefault(); pick(shown[active]) }
    } else if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); revert() }
    } else if (event.key === 'Tab') {
      if (open) settle()
    }
  }

  return <span className={`client-combo${className ? ` ${className}` : ''}`}>
    <input ref={input} className="client-combo-input" type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined} aria-label={rest['aria-label']}
      value={text} placeholder={blank?.label || placeholder} disabled={disabled} required={required && !current} autoComplete="off" spellCheck={false}
      onFocus={event => { event.currentTarget.select(); setTyped(false); setOpen(true); setActive(Math.max(0, choices.findIndex(choice => choice.value === current))) }}
      onClick={() => { if (!open) setOpen(true) }}
      onChange={event => { setText(event.target.value); setTyped(true); setOpen(true); setActive(0) }}
      onBlur={settle} onKeyDown={keys} />
    {name && <input type="hidden" name={name} value={current} disabled={disabled} />}
    {open && !disabled && <ul ref={list} id={listId} role="listbox" className="client-combo-list" style={place}>
      {shown.map((choice, at) => <li key={choice.value || '__blank'} id={`${listId}-${at}`} role="option" aria-selected={choice.value === current} data-active={at === active}
        className={`${choice.value === current ? 'chosen' : ''}${extra.includes(choice) ? ' extra' : ''}`}
        onMouseDown={event => { event.preventDefault(); pick(choice) }} onMouseEnter={() => setActive(at)}>{choice.label}</li>)}
      {!shown.length && <li className="client-combo-empty" role="presentation">No client matches “{text.trim()}”</li>}
    </ul>}
  </span>
}
