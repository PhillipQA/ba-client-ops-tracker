/**
 * Settings › Workflow › Custom task fields: add, rename, reorder and remove the account's own task fields, choose
 * their type, a Choice field's options, and whether they show as a Tasks table column. Saved with the workflow.
 */
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import '../tasks/taskViews.css'
import { FIELD_LIMITS, FIELD_TYPES, fieldIdFor, type TaskFieldDef, type TaskFieldType } from '../tasks/customFields'

type Props = {
  fields: TaskFieldDef[]
  onChange: (fields: TaskFieldDef[]) => void
}

/** What's wrong with the fields, for the editor's warning ('' when they can be saved). */
export function customFieldsProblem(fields: TaskFieldDef[]) {
  const names = fields.map(field => field.name.trim().toLowerCase())
  if (names.some(name => !name)) return 'Every custom field needs a name.'
  if (new Set(names).size !== names.length) return 'Custom field names must be different.'
  const choice = fields.find(field => field.type === 'select' && !(field.options || []).some(option => option.trim()))
  if (choice) return `Give “${choice.name}” at least one choice.`
  return ''
}

const optionsText = (options: string[] | undefined) => (options || []).join(', ')
const parseOptions = (text: string) =>
  text
    .split(/[,\n]/)
    .map(option => option.trim())
    .filter(Boolean)
    .slice(0, FIELD_LIMITS.options)

export function CustomFieldsEditor({ fields, onChange }: Props) {
  // A Choice field's options as typed (commas are only split on save, so typing "a, b" works).
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const update = (id: string, change: Partial<TaskFieldDef>) =>
    onChange(fields.map(field => (field.id === id ? { ...field, ...change } : field)))
  const move = (from: number, by: number) => {
    const next = [...fields]
    const [field] = next.splice(from, 1)
    next.splice(from + by, 0, field)
    onChange(next)
  }
  const add = () => {
    const name = `Field ${fields.length + 1}`
    onChange([
      ...fields,
      {
        id: fieldIdFor(
          name,
          fields.map(field => field.id),
        ),
        name,
        type: 'text',
      },
    ])
  }

  return (
    <div className="custom-fields-editor">
      <h5>Custom task fields</h5>
      <p className="muted">
        Your own fields on every task, such as Module, Ticket link or Story points. They appear in the task form, can
        show as a Tasks table column, and are found by search. Removing a field hides its values; they are not deleted.
      </p>
      {fields.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Choices (Choice fields)</th>
              <th>Table column</th>
              <th aria-label="Order and remove" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, at) => (
              <tr key={field.id}>
                <td>
                  <input
                    type="text"
                    aria-label="Field name"
                    value={field.name}
                    maxLength={FIELD_LIMITS.name}
                    onChange={event => update(field.id, { name: event.target.value })}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Type of ${field.name}`}
                    value={field.type}
                    onChange={event => {
                      const type = event.target.value as TaskFieldType
                      update(field.id, type === 'select' ? { type, options: field.options || [] } : { type, options: undefined })
                    }}
                  >
                    {FIELD_TYPES.map(type => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {field.type === 'select' ? (
                    <input
                      type="text"
                      aria-label={`Choices for ${field.name}`}
                      placeholder="High, Medium, Low"
                      value={drafts[field.id] ?? optionsText(field.options)}
                      onChange={event => {
                        setDrafts({ ...drafts, [field.id]: event.target.value })
                        update(field.id, { options: parseOptions(event.target.value) })
                      }}
                    />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Show ${field.name} as a Tasks column`}
                    checked={Boolean(field.showInTable)}
                    onChange={event => update(field.id, { showInTable: event.target.checked || undefined })}
                  />
                </td>
                <td>
                  <div className="workflow-row-actions">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${field.name} up`}
                      disabled={at === 0}
                      onClick={() => move(at, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move ${field.name} down`}
                      disabled={at === fields.length - 1}
                      onClick={() => move(at, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${field.name}`}
                      onClick={() => onChange(fields.filter(candidate => candidate.id !== field.id))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <button type="button" className="secondary" disabled={fields.length >= FIELD_LIMITS.fields} onClick={add}>
          <Plus size={14} /> Add a field
        </button>
      </div>
    </div>
  )
}
