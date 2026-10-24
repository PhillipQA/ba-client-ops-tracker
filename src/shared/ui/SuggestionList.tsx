import type { Suggestion } from './RecipientInput'

/** The dropdown under a field that suggests people. Used by the recipient lines and by the signatory name fields. */
export function SuggestionList({
  id,
  label,
  people,
  highlighted,
  optionId,
  onChoose,
  onHover,
}: {
  id: string
  label: string
  people: Suggestion[]
  highlighted: number
  optionId: (index: number) => string
  onChoose: (person: Suggestion) => void
  onHover: (index: number) => void
}) {
  return (
    <ul id={id} role="listbox" aria-label={`${label} suggestions`} className="email-suggestions">
      {people.map((person, index) => (
        <li
          key={person.email}
          id={optionId(index)}
          role="option"
          aria-selected={index === highlighted}
          className={index === highlighted ? 'active' : undefined}
          // Mouse down, not click, so the field keeps focus and the choice is not lost to the blur.
          onMouseDown={event => {
            event.preventDefault()
            onChoose(person)
          }}
          onMouseMove={() => {
            if (index !== highlighted) onHover(index)
          }}
        >
          <span>
            <strong>{person.name || person.email}</strong>
            {person.name && <small>{person.email}</small>}
          </span>
          {person.hint && <em>{person.hint}</em>}
        </li>
      ))}
    </ul>
  )
}

/** The text a screen reader announces when the list opens. */
export const suggestionStatus = (count: number) =>
  count ? `${count} ${count === 1 ? 'suggestion' : 'suggestions'} available. Use the up and down arrow keys.` : ''
