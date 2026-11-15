/**
 * Customizing the Action Center: a toolbar to start and finish, a frame around each widget to drag, resize or hide it,
 * and a list of widgets to add. Changes are a draft until Save; Cancel puts the page back as it was.
 */
import { ArrowDown, ArrowUp, Check, GripVertical, LayoutGrid, Plus, RotateCcw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import {
  ACTION_CENTER_WIDGETS,
  type ActionCenterLayout,
  addWidget,
  moveWidget,
  removeWidget,
  setWidgetWidth,
  type WidgetDefinition,
  type WidgetId,
} from '../../shared/actionCenterLayout'
import type { RoleLayout } from './useActionCenterLayout'

const labelOf = (id: WidgetId) => ACTION_CENTER_WIDGETS.find(widget => widget.id === id)?.label || id

/** The frame around a widget while customizing: drag handle, name, move, width, hide. The widget below is inert. */
export function WidgetFrame({
  id,
  index,
  layout,
  onChange,
  dragging,
  setDragging,
  children,
}: {
  id: WidgetId
  index: number
  layout: ActionCenterLayout
  onChange: (layout: ActionCenterLayout) => void
  dragging: WidgetId | ''
  setDragging: (id: WidgetId | '') => void
  children: ReactNode
}) {
  const width = layout.find(item => item.id === id)?.width || 'full'
  return (
    <div
      className={`ac-frame${dragging === id ? ' dragging' : ''}`}
      onDragOver={event => {
        if (!dragging || dragging === id) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={event => {
        event.preventDefault()
        if (dragging && dragging !== id) onChange(moveWidget(layout, dragging, index))
        setDragging('')
      }}
    >
      <div
        className="ac-frame-bar"
        draggable
        onDragStart={event => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', id)
          setDragging(id)
        }}
        onDragEnd={() => setDragging('')}
      >
        <GripVertical size={16} aria-hidden="true" className="ac-grip" />
        <strong>{labelOf(id)}</strong>
        <div className="ac-frame-actions">
          <button
            type="button"
            aria-label={`Move ${labelOf(id)} up`}
            disabled={index === 0}
            onClick={() => onChange(moveWidget(layout, id, index - 1))}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            aria-label={`Move ${labelOf(id)} down`}
            disabled={index === layout.length - 1}
            onClick={() => onChange(moveWidget(layout, id, index + 1))}
          >
            <ArrowDown size={14} />
          </button>
          <div className="ac-width" role="group" aria-label={`Width of ${labelOf(id)}`}>
            <button
              type="button"
              aria-pressed={width === 'half'}
              onClick={() => onChange(setWidgetWidth(layout, id, 'half'))}
            >
              Half
            </button>
            <button
              type="button"
              aria-pressed={width === 'full'}
              onClick={() => onChange(setWidgetWidth(layout, id, 'full'))}
            >
              Full
            </button>
          </div>
          <button type="button" aria-label={`Hide ${labelOf(id)}`} onClick={() => onChange(removeWidget(layout, id))}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="ac-frame-body" inert>
        {children}
      </div>
    </div>
  )
}

/** The bar shown while customizing: add widgets, reset, save for a role (Administrators), cancel, save. */
export function CustomizeBar({
  draft,
  onChange,
  addable,
  role,
  hasOwn,
  isAdmin,
  roles,
  onReset,
  onSaveForRole,
  onCancel,
  onSave,
  note,
}: {
  draft: ActionCenterLayout
  onChange: (layout: ActionCenterLayout) => void
  addable: WidgetDefinition[]
  role: RoleLayout
  hasOwn: boolean
  isAdmin: boolean
  roles: { id: string; name: string }[]
  onReset: () => void
  onSaveForRole: (roleId: string) => Promise<void>
  onCancel: () => void
  onSave: () => void
  note: string
}) {
  const [roleId, setRoleId] = useState('')
  const [roleBusy, setRoleBusy] = useState(false)
  const [roleMessage, setRoleMessage] = useState('')
  return (
    <div className="panel ac-customize-bar">
      <div className="ac-customize-head">
        <div>
          <h2>
            <LayoutGrid size={17} /> Customize your Action Center
          </h2>
          <p>Drag a widget by its bar, or use the arrows. Choose half or full width, hide what you don’t use.</p>
        </div>
        <div className="ac-customize-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={onSave}>
            <Check size={15} /> Save layout
          </button>
        </div>
      </div>
      {addable.length > 0 && (
        <div className="ac-add">
          <span>Add:</span>
          {addable.map(widget => (
            <button
              type="button"
              key={widget.id}
              className="secondary"
              title={widget.description}
              onClick={() => onChange(addWidget(draft, widget.id))}
            >
              <Plus size={14} /> {widget.label}
            </button>
          ))}
        </div>
      )}
      <div className="ac-customize-foot">
        {hasOwn && (
          <button type="button" className="link-button" onClick={onReset}>
            <RotateCcw size={13} /> {role ? `Go back to the ${role.name} layout` : 'Go back to the standard layout'}
          </button>
        )}
        {isAdmin && roles.length > 0 && (
          <span className="ac-role-save">
            <span>Starting layout for</span>
            <select value={roleId} onChange={event => setRoleId(event.target.value)} aria-label="Role">
              <option value="">Choose a role</option>
              {roles.map(option => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              disabled={!roleId || roleBusy}
              onClick={() => {
                setRoleBusy(true)
                setRoleMessage('')
                onSaveForRole(roleId)
                  .then(() =>
                    setRoleMessage(
                      `Saved for ${roles.find(option => option.id === roleId)?.name}. People with that role who haven’t made their own layout get it on their next visit.`,
                    ),
                  )
                  .catch(error => setRoleMessage(error instanceof Error ? error.message : 'Could not save.'))
                  .finally(() => setRoleBusy(false))
              }}
            >
              Save this layout for the role
            </button>
          </span>
        )}
      </div>
      {(roleMessage || note) && <p className="ac-widget-note">{roleMessage || note}</p>}
    </div>
  )
}
