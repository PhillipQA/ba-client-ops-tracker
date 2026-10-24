import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Link2 } from 'lucide-react'
import {
  cleanCell,
  linkToInput,
  parseLink,
  type Cell,
  type SelectOption,
  type TrackerColumn,
  type TrackerRow,
} from './trackerModel'
import { shown, type Lookup } from './trackerQuery'
import { Avatar, Pill, Popover, niceDate } from './trackerUi'

export type Person = { id: string; name: string }

export const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 10 })

function linkLabel(href: string) {
  try {
    const url = new URL(href)
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 80)
  } catch {
    return href
  }
}

/** What a cell looks like when it is not being edited. */
export function CellView({
  column,
  row,
  lookup,
  canEdit,
  onToggle,
}: {
  column: TrackerColumn
  row: TrackerRow
  lookup: Lookup
  canEdit: boolean
  onToggle: (value: boolean) => void
}): ReactNode {
  const value = row.cells[column.id]
  switch (column.type) {
    case 'text':
    case 'longtext':
      return (
        <span className="trk-text" title={typeof value === 'string' && value.length > 24 ? value : undefined}>
          {typeof value === 'string' ? value : ''}
        </span>
      )
    case 'number':
      return <span className="trk-number">{typeof value === 'number' ? numberFormat.format(value) : ''}</span>
    case 'date':
      return <span>{typeof value === 'string' && value ? niceDate(value) : ''}</span>
    case 'link': {
      const { label, href } = parseLink(typeof value === 'string' ? value : '')
      return href ? (
        <a
          className="trk-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={label ? href : undefined}
          onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
        >
          {label || linkLabel(href)}
        </a>
      ) : null
    }
    case 'checkbox':
      return (
        <input
          type="checkbox"
          className="trk-check"
          checked={value === true}
          disabled={!canEdit}
          aria-label={`${column.name}: ${value === true ? 'yes' : 'no'}`}
          onClick={event => event.stopPropagation()}
          onChange={event => onToggle(event.target.checked)}
        />
      )
    case 'select': {
      const option = column.options?.find(item => item.id === value)
      return option ? <Pill tone={option.color}>{option.label}</Pill> : null
    }
    case 'multiselect': {
      const chosen = (Array.isArray(value) ? value : [])
        .map(id => column.options?.find(item => item.id === id))
        .filter((item): item is SelectOption => Boolean(item))
      return (
        <span className="trk-pills">
          {chosen.map(option => (
            <Pill key={option.id} tone={option.color}>
              {option.label}
            </Pill>
          ))}
        </span>
      )
    }
    case 'person': {
      const name = shown(column, row, lookup).text
      return name ? (
        <span className="trk-person">
          <Avatar name={name} />
          <span className="trk-text">{name}</span>
        </span>
      ) : null
    }
    case 'formula': {
      const cell = shown(column, row, lookup)
      if (cell.note === 'formula-error')
        return (
          <span
            className="trk-formula-error"
            title={
              cell.text === '#DIV/0'
                ? 'This row divides by 0.'
                : 'The formula could not be worked out. Edit the column to check it.'
            }
          >
            {cell.text}
          </span>
        )
      return <span className="trk-number">{typeof cell.key === 'number' ? numberFormat.format(cell.key) : ''}</span>
    }
    case 'secret':
      return row.secretSet[column.id] ? (
        <span className="trk-secret" aria-label="A value is set. Open the row to reveal it.">
          ••••••••
        </span>
      ) : null
    default: {
      const cell = shown(column, row, lookup)
      if (cell.note === 'unlinked')
        return (
          <span className="trk-muted" title="This row is not linked to a task">
            —
          </span>
        )
      if (cell.note === 'removed')
        return (
          <span
            className="trk-muted trk-warn"
            title="The linked task was deleted. Link another task or unlink this row."
          >
            Task removed
          </span>
        )
      if (!cell.text) return <span className="trk-muted">—</span>
      return cell.tone ? <Pill tone={cell.tone}>{cell.text}</Pill> : <span className="trk-text">{cell.text}</span>
    }
  }
}

export const editable = (column: TrackerColumn) =>
  ['text', 'number', 'date', 'link', 'select', 'multiselect', 'person'].includes(column.type)

/** Text for the editing box. */
function draftOf(column: TrackerColumn, value: Cell | undefined) {
  if (value === undefined || value === null) return ''
  return column.type === 'number'
    ? String(value)
    : column.type === 'link' && typeof value === 'string'
      ? linkToInput(value)
      : typeof value === 'string'
        ? value
        : ''
}

type EditorProps = {
  column: TrackerColumn
  row: TrackerRow
  people: Person[]
  /** A character typed to start editing replaces the old value, like a spreadsheet. */
  initial?: string
  /** Stops editing. `move` says where the selection goes next. */
  onDone: (move?: 'down' | 'right') => void
  onCommit: (value: Cell) => void
  onInvalid: (message: string) => void
}

export function CellEditor(props: EditorProps) {
  const { column } = props
  if (column.type === 'select' || column.type === 'multiselect' || column.type === 'person')
    return <PickerEditor {...props} />
  return <InputEditor {...props} />
}

function InputEditor({ column, row, initial, onDone, onCommit, onInvalid }: EditorProps) {
  const original = draftOf(column, row.cells[column.id])
  const [draft, setDraft] = useState(initial ?? original)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.focus()
    if (initial === undefined && column.type !== 'date') element.select()
  }, [])
  const finish = (move?: 'down' | 'right', fromBlur = false) => {
    if (finished.current) return
    if (draft === original) {
      finished.current = true
      onDone(move)
      return
    }
    const result = cleanCell(column, draft)
    if (!result.ok) {
      if (fromBlur) {
        finished.current = true
        onInvalid(result.error)
        onDone()
      } else setError(result.error)
      return
    }
    finished.current = true
    onCommit(result.value)
    onDone(move)
  }
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish('down')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finish(event.shiftKey ? undefined : 'right')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finished.current = true
      onDone()
    }
  }
  return (
    <input
      ref={input}
      className={error ? 'trk-input invalid' : 'trk-input'}
      type={column.type === 'date' ? 'date' : 'text'}
      inputMode={column.type === 'number' ? 'decimal' : undefined}
      value={draft}
      aria-label={column.name}
      aria-invalid={error ? true : undefined}
      title={error || undefined}
      onChange={event => {
        setDraft(event.target.value)
        setError('')
      }}
      onKeyDown={keys}
      onBlur={() => finish(undefined, true)}
    />
  )
}

function PickerEditor({ column, row, people, onDone, onCommit }: EditorProps) {
  const anchor = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const multiple = column.type === 'multiselect',
    isPerson = column.type === 'person'
  const current = row.cells[column.id]
  const chosen = new Set<string>(
    multiple ? (Array.isArray(current) ? current : []) : typeof current === 'string' && current ? [current] : [],
  )
  const items = useMemo(() => {
    const list = isPerson
      ? [...people]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(person => ({ id: person.id, label: person.name, color: undefined as SelectOption['color'] | undefined }))
      : (column.options || []).map(option => ({
          id: option.id,
          label: option.label,
          color: option.color as SelectOption['color'] | undefined,
        }))
    const wanted = query.trim().toLowerCase()
    return wanted ? list.filter(item => item.label.toLowerCase().includes(wanted)) : list
  }, [column, people, query, isPerson])
  const list = useRef<HTMLDivElement>(null)
  const pick = (id: string) => {
    if (multiple) {
      const next = new Set(chosen)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onCommit([...next])
    } else {
      onCommit(chosen.has(id) ? '' : id)
      onDone()
    }
  }
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button[data-item]') || [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[Math.min(buttons.length - 1, at + 1)]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (at <= 0) (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
      else buttons[at - 1]?.focus()
    } else if (event.key === 'Enter' && document.activeElement instanceof HTMLInputElement && items[0]) {
      event.preventDefault()
      pick(items[0].id)
    }
  }
  const searchable = isPerson || items.length > 7 || query !== ''
  return (
    <>
      <div ref={anchor} className="trk-edit-anchor">
        <CurrentValue column={column} row={row} people={people} />
      </div>
      <Popover anchor={anchor} onClose={() => onDone()} label={`Choose ${column.name}`} className="trk-picker">
        <div onKeyDown={keys}>
          {searchable && (
            <input
              className="trk-picker-search"
              autoFocus
              placeholder={isPerson ? 'Find a teammate' : 'Find an option'}
              value={query}
              onChange={event => setQuery(event.target.value)}
              aria-label="Search"
            />
          )}
          <div ref={list} className="trk-picker-list" role={multiple ? 'group' : 'listbox'} aria-label={column.name}>
            {items.map(item => (
              <button
                type="button"
                key={item.id}
                data-item
                role={multiple ? 'checkbox' : 'option'}
                aria-checked={multiple ? chosen.has(item.id) : undefined}
                aria-selected={multiple ? undefined : chosen.has(item.id)}
                autoFocus={!searchable && (chosen.has(item.id) || item === items[0])}
                className={chosen.has(item.id) ? 'selected' : ''}
                onClick={() => pick(item.id)}
              >
                {item.color ? (
                  <Pill tone={item.color}>{item.label}</Pill>
                ) : (
                  <span className="trk-person">
                    <Avatar name={item.label} />
                    <span>{item.label}</span>
                  </span>
                )}
                {chosen.has(item.id) && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!items.length && (
              <p className="trk-picker-empty">
                {isPerson ? 'No teammate matches.' : 'No options. Add options from the column menu.'}
              </p>
            )}
          </div>
          {chosen.size > 0 && (
            <button
              type="button"
              className="trk-picker-clear"
              onClick={() => {
                onCommit(multiple ? [] : '')
                onDone()
              }}
            >
              Clear
            </button>
          )}
        </div>
      </Popover>
    </>
  )
}

function CurrentValue({ column, row, people }: { column: TrackerColumn; row: TrackerRow; people: Person[] }) {
  const value = row.cells[column.id]
  if (column.type === 'person') {
    const name = people.find(person => person.id === value)?.name || (value ? 'Unknown user' : '')
    return name ? (
      <span className="trk-person">
        <Avatar name={name} />
        <span className="trk-text">{name}</span>
      </span>
    ) : null
  }
  const ids = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
  return (
    <span className="trk-pills">
      {ids.map(id => {
        const option = column.options?.find(item => item.id === id)
        return option ? (
          <Pill key={id} tone={option.color}>
            {option.label}
          </Pill>
        ) : null
      })}
    </span>
  )
}

export function LinkedIcon({ title }: { title: string }) {
  return (
    <span className="trk-linked" role="img" aria-label={title} title={title}>
      <Link2 size={13} aria-hidden="true" />
    </span>
  )
}
