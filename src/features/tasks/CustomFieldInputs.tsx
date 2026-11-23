/**
 * The task form's custom fields (Settings › Workflow › Custom task fields): one input per field, by its type.
 * Values are kept in the parent's state and cleaned on save (customFields.ts).
 */
import type { TaskFieldDef, TaskFieldValue } from './customFields'

type Props = {
  fields: TaskFieldDef[]
  values: Record<string, TaskFieldValue | string>
  onChange: (id: string, value: TaskFieldValue | string) => void
  disabled?: boolean
}

export function CustomFieldInputs({ fields, values, onChange, disabled }: Props) {
  return (
    <>
      {fields.map(field => {
        const value = values[field.id]
        const id = `custom-field-${field.id}`
        if (field.type === 'checkbox')
          return (
            <label key={field.id} className="custom-field-check">
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={event => onChange(field.id, event.target.checked)}
              />
              {field.name}
            </label>
          )
        return (
          <label key={field.id}>
            {field.name}
            {field.type === 'select' ? (
              <select
                id={id}
                value={String(value ?? '')}
                disabled={disabled}
                onChange={event => onChange(field.id, event.target.value)}
              >
                <option value="">—</option>
                {/* A value that is no longer an option is still shown, as it was saved. */}
                {value && !field.options?.includes(String(value)) && (
                  <option value={String(value)}>{String(value)}</option>
                )}
                {field.options?.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={
                  field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : field.type === 'url'
                        ? 'url'
                        : 'text'
                }
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                step={field.type === 'number' ? 'any' : undefined}
                placeholder={field.type === 'url' ? 'https://' : undefined}
                maxLength={1000}
                value={String(value ?? '')}
                disabled={disabled}
                onChange={event => onChange(field.id, event.target.value)}
              />
            )}
          </label>
        )
      })}
    </>
  )
}
