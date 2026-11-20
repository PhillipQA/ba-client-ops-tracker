/**
 * Mounted once for the whole app: a dropdown (<select>) with more than SEARCH_AFTER choices opens a type-to-search
 * list instead of the browser's long scrolling list, so every form gets it without changes. Typing a letter on a
 * focused dropdown opens it with that letter typed. Phones and tablets (touch) keep the native list, and so does a
 * select marked `data-native`. Picking a choice changes the <select> the way the browser would, so forms, React state
 * and validation see an ordinary change.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { type SelectOption, matchOptions, usesSearch } from './selectSearch'

// A hidden option (a "Choose…" placeholder) is not offered.
function optionsOf(select: HTMLSelectElement): SelectOption[] {
  return Array.from(select.options)
    .filter(option => !option.hidden)
    .map(option => {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null
      return {
        value: option.value,
        label: option.label || option.text,
        group: group?.label || '',
        disabled: option.disabled || Boolean(group?.disabled),
      }
    })
}

/** Sets the select's value as if chosen in its own list: React's onChange and plain change listeners both see it. */
function choose(select: HTMLSelectElement, value: string) {
  if (select.value === value) return
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (setter) setter.call(select, value)
  else select.value = value
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function classes(option: SelectOption, current: string) {
  const names = [option.value === current && 'chosen', option.value === '' && 'extra', option.disabled && 'disabled']
  return names.filter(Boolean).join(' ') || undefined
}

export default function LongSelectSearch() {
  const [select, setSelect] = useState<HTMLSelectElement | null>(null)
  const [options, setOptions] = useState<SelectOption[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState<CSSProperties>({})
  const [host, setHost] = useState<HTMLElement | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const pointer = useRef('mouse')
  const openOn = useRef<HTMLSelectElement | null>(null)
  openOn.current = select
  const listId = useId()
  const shown = matchOptions(options, query)

  const open = useCallback((target: HTMLSelectElement, typed = '') => {
    const all = optionsOf(target)
    setOptions(all)
    setQuery(typed)
    const chosen = all.findIndex(option => option.value === target.value)
    setActive(typed ? 0 : Math.max(0, chosen))
    setSelect(target)
  }, [])
  const close = useCallback((refocus: boolean) => {
    setSelect(current => {
      if (refocus) current?.focus()
      return null
    })
  }, [])

  // Clicks and keys on any long dropdown open the search list in place of the browser's own.
  useEffect(() => {
    const down = (event: PointerEvent) => {
      pointer.current = event.pointerType
    }
    const mouse = (event: MouseEvent) => {
      if (event.button !== 0 || pointer.current === 'touch') return
      const target = event.target
      if (!(target instanceof HTMLSelectElement) || !usesSearch(target)) return
      event.preventDefault()
      // A second click on the same dropdown closes its list, like the browser's.
      if (openOn.current === target) {
        setSelect(null)
        return
      }
      target.focus()
      open(target)
    }
    const key = (event: KeyboardEvent) => {
      const target = event.target
      if (!(target instanceof HTMLSelectElement) || !usesSearch(target) || event.ctrlKey || event.metaKey) return
      const opens =
        event.key === 'Enter' ||
        event.key === ' ' ||
        event.key === 'F4' ||
        (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
      const letter = event.key.length === 1 && event.key !== ' ' && !event.altKey
      if (!opens && !letter) return
      event.preventDefault()
      open(target, letter ? event.key : '')
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('mousedown', mouse, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('mousedown', mouse, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open])

  // A click anywhere else closes it. A click on a long dropdown (this one or another) is handled above.
  useEffect(() => {
    if (!select) return
    const outside = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && panel.current?.contains(target)) return
      if (target instanceof HTMLSelectElement && usesSearch(target)) return
      close(false)
    }
    document.addEventListener('mousedown', outside, true)
    return () => document.removeEventListener('mousedown', outside, true)
  }, [select, close])

  // The list floats over dialogs and scrolling panels and follows the dropdown on screen, in the dropdown's colours.
  useLayoutEffect(() => {
    if (!select) return
    const follow = () => {
      if (!select.isConnected) {
        setSelect(null)
        return
      }
      const box = select.getBoundingClientRect()
      const below = window.innerHeight - box.bottom - 12,
        above = box.top - 12
      const up = below < 260 && above > below
      const maxHeight = Math.max(140, Math.min(380, up ? above : below))
      const width = Math.min(Math.max(box.width, 260), window.innerWidth - 16)
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8))
      // Inside a dialog moved by a transform, `fixed` is measured from the dialog: find where 0,0 really is by placing
      // the panel there for a moment, and measure its height at this width (to open it upwards right above the field).
      let originX = 0,
        originY = 0,
        height = 0
      const el = panel.current
      if (el) {
        const keep = el.getAttribute('style') || ''
        const scrolled = list.current?.scrollTop || 0
        el.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;width:${width}px;max-height:${maxHeight}px`
        const probe = el.getBoundingClientRect()
        originX = probe.left
        originY = probe.top
        height = probe.height
        el.setAttribute('style', keep)
        if (list.current) list.current.scrollTop = scrolled
      }
      const top = up ? box.top - 4 - height : box.bottom + 4
      const look = getComputedStyle(select)
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
    setHost(select.closest<HTMLElement>('dialog[open]') || document.body)
    follow()
    const scrolled = (event: Event) => {
      if (panel.current && event.target instanceof Node && panel.current.contains(event.target)) return
      follow()
    }
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', scrolled, true)
    return () => {
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', scrolled, true)
    }
  }, [select, shown.length, host])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, select])

  if (!select || !host) return null
  const current = select.value
  const pick = (option: SelectOption) => {
    if (option.disabled) return
    choose(select, option.value)
    close(true)
  }
  const step = (from: number, by: number) => {
    for (let at = from + by; at >= 0 && at < shown.length; at += by) if (!shown[at].disabled) return at
    return from
  }
  const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || 'Choose'
  return createPortal(
    <div ref={panel} className="select-search" style={place}>
      <input
        autoFocus
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        aria-label={`Search ${label}`}
        placeholder="Type to search"
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={event => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setActive(at => step(at, event.key === 'ArrowDown' ? 1 : -1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (shown[active]) pick(shown[active])
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === 'Tab') close(false)
        }}
      />
      <ul ref={list} id={listId} role="listbox" aria-label={label} className="client-combo-list">
        {shown.map((option, at) => [
          option.group && option.group !== shown[at - 1]?.group ? (
            <li key={`group:${option.group}:${at}`} className="client-combo-group" role="presentation">
              {option.group}
            </li>
          ) : null,
          <li
            key={`${option.value}:${at}`}
            id={`${listId}-${at}`}
            role="option"
            aria-selected={option.value === current}
            aria-disabled={option.disabled || undefined}
            data-active={at === active}
            className={classes(option, current)}
            onMouseDown={event => {
              event.preventDefault()
              pick(option)
            }}
            onMouseEnter={() => setActive(at)}
          >
            {option.label || ' '}
          </li>,
        ])}
        {!shown.length && (
          <li className="client-combo-empty" role="presentation">
            Nothing matches “{query.trim()}”
          </li>
        )}
      </ul>
    </div>,
    host,
  )
}
