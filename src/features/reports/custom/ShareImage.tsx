/**
 * Share a report as a picture: copy it to paste into Gmail, Teams or Viber, download it as a PNG, or open an email
 * with the picture attached. The picture is what this person sees now, drawn in their browser.
 */
import { Clipboard, Download, ImageIcon, Mail } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { blobBase64, canvasBlob, snapshotElement } from '../../../shared/ui/snapshot'
import { composeEmail } from '../../email/composeEvent'
import { useEmailEnabled } from '../../email/EmailComposer'

const fileName = (name: string, today: string) =>
  `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report'}-${today}.png`

export function ShareImage({
  target,
  name,
  today,
}: {
  target: RefObject<HTMLElement | null>
  name: string
  today: string
}) {
  const emailEnabled = useEmailEnabled()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const picture = async () => {
    const area = target.current
    if (!area) throw new Error('Open the report first.')
    // Grow every widget to show all its rows (no scroll bars), take the picture, then put the page back.
    area.classList.add('crp-expanded')
    try {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return await canvasBlob(await snapshotElement(area, { skip: '.no-print', maxWidth: 1600 }))
    } finally {
      area.classList.remove('crp-expanded')
    }
  }
  const act = async (label: string, action: () => Promise<string>) => {
    setBusy(true)
    setMessage(`${label}…`)
    try {
      setMessage(await action())
      setOpen(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The picture could not be made.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="crp-share" ref={menu}>
      <button type="button" className="crp-btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <ImageIcon size={14} /> Share as image
      </button>
      {open && (
        <div className="crp-share-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() =>
              void act('Copying', async () => {
                if (!navigator.clipboard || typeof ClipboardItem === 'undefined')
                  throw new Error('This browser cannot copy pictures. Use Download instead.')
                // Safari needs the clipboard write to start right away, with the picture still being made.
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': picture() })])
                return 'Copied. Paste it into an email or chat.'
              })
            }
          >
            <Clipboard size={14} /> Copy image
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() =>
              void act('Making the picture', async () => {
                const url = URL.createObjectURL(await picture())
                const link = document.createElement('a')
                link.href = url
                link.download = fileName(name, today)
                link.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
                return 'Downloaded.'
              })
            }
          >
            <Download size={14} /> Download PNG
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            title={emailEnabled ? undefined : 'Connect Gmail in Work Hub to email from the app'}
            onClick={() =>
              void act('Making the picture', async () => {
                if (!emailEnabled) throw new Error('Connect Gmail in Work Hub first, or use Copy image.')
                const blob = await picture()
                composeEmail({
                  subject: `${name} (${today})`,
                  message: `Hi,\n\nHere is ${name} as of ${today}. The picture is attached.\n`,
                  uploads: [
                    {
                      name: fileName(name, today),
                      mimeType: 'image/png',
                      size: blob.size,
                      data: await blobBase64(blob),
                    },
                  ],
                })
                return 'Email opened with the picture attached.'
              })
            }
          >
            <Mail size={14} /> Email with the image
          </button>
        </div>
      )}
      {message && (
        <span className="crp-muted crp-share-note" role="status">
          {message}
        </span>
      )}
    </div>
  )
}
