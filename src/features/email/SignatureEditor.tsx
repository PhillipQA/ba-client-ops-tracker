// The signature editor, like Gmail's: bold, italic, underline, text colour, highlight, font, size, links and images
// (a logo). What it produces is cleaned by sanitizeSignature before it is shown, saved or sent.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Bold, Eraser, Highlighter, ImagePlus, Italic, Link2, Palette, Underline } from 'lucide-react'
import { SIGNATURE_LIMITS } from './signatureHtml'

const FONTS = ['Arial', 'Verdana', 'Tahoma', 'Georgia', 'Times New Roman', 'Courier New']
const SIZES: [string, string][] = [
  ['2', 'Small'],
  ['3', 'Normal'],
  ['4', 'Large'],
  ['5', 'Huge'],
]
const MAX_IMAGE_WIDTH = 480

/** The picture as embedded data, made smaller when it is wider than a signature needs. */
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`“${file.name}” could not be read.`))
    reader.onload = () => {
      const original = String(reader.result || '')
      const image = new Image()
      image.onerror = () => reject(new Error(`“${file.name}” is not a picture this can use.`))
      image.onload = () => {
        if (image.width <= MAX_IMAGE_WIDTH && file.type !== 'image/webp') return resolve(original)
        const scale = Math.min(1, MAX_IMAGE_WIDTH / image.width)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.width * scale)
        canvas.height = Math.round(image.height * scale)
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9))
      }
      image.src = original
    }
    reader.readAsDataURL(file)
  })
}

export function SignatureEditor({ html, onChange }: { html: string; onChange: (html: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState('')
  // The starting signature is put in once; after that the box holds what is typed.
  useEffect(() => {
    if (box.current) box.current.innerHTML = html
  }, [])
  const changed = () => onChange(box.current?.innerHTML || '')
  const run = (command: string, value?: string) => {
    box.current?.focus()
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand(command, false, value)
    changed()
  }
  // Toolbar buttons keep the selection in the box: the press is handled, the focus does not move.
  const button = (label: string, icon: ReactNode, action: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={event => {
        event.preventDefault()
        action()
      }}
    >
      {icon}
    </button>
  )
  const addImage = async (file: File | undefined) => {
    if (picker.current) picker.current.value = ''
    if (!file) return
    setNote('')
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setNote('Use a PNG, JPEG or GIF picture.')
    if ((box.current?.querySelectorAll('img').length || 0) >= SIGNATURE_LIMITS.images)
      return setNote(`A signature can have at most ${SIGNATURE_LIMITS.images} pictures.`)
    try {
      const data = await readImage(file)
      if (Math.floor((data.length - data.indexOf(',') - 1) * 0.75) > SIGNATURE_LIMITS.imageBytes)
        return setNote('That picture is too large for a signature. Use a smaller one (under 200 KB).')
      run('insertImage', data)
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'The picture could not be added.')
    }
  }
  return (
    <div className="signature-editor">
      <div className="signature-toolbar" role="toolbar" aria-label="Signature formatting">
        <select
          aria-label="Font"
          defaultValue=""
          onChange={event => {
            if (event.target.value) run('fontName', event.target.value)
            event.target.value = ''
          }}
        >
          <option value="">Font</option>
          {FONTS.map(font => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
        <select
          aria-label="Text size"
          defaultValue=""
          onChange={event => {
            if (event.target.value) run('fontSize', event.target.value)
            event.target.value = ''
          }}
        >
          <option value="">Size</option>
          {SIZES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {button('Bold', <Bold size={15} />, () => run('bold'))}
        {button('Italic', <Italic size={15} />, () => run('italic'))}
        {button('Underline', <Underline size={15} />, () => run('underline'))}
        <label className="signature-color" title="Text colour">
          <Palette size={15} aria-hidden="true" />
          <input type="color" aria-label="Text colour" onChange={event => run('foreColor', event.target.value)} />
        </label>
        <label className="signature-color" title="Highlight">
          <Highlighter size={15} aria-hidden="true" />
          <input
            type="color"
            aria-label="Highlight colour"
            defaultValue="#ffff00"
            onChange={event => run('hiliteColor', event.target.value)}
          />
        </label>
        {button('Link', <Link2 size={15} />, () => {
          const address = window.prompt('Link address (https://… or an email address)')?.trim()
          if (!address) return
          const href = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
            ? `mailto:${address}`
            : /^https?:\/\//i.test(address)
              ? address
              : `https://${address}`
          run('createLink', href)
        })}
        {button('Picture', <ImagePlus size={15} />, () => picker.current?.click())}
        {button('Remove formatting', <Eraser size={15} />, () => run('removeFormat'))}
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={event => void addImage(event.target.files?.[0])}
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a formatted text box has no native element */}
      <div
        ref={box}
        className="signature-box"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label="Email signature"
        onInput={changed}
        onBlur={changed}
      />
      {note && (
        <small role="alert" className="email-error">
          {note}
        </small>
      )}
    </div>
  )
}
