import nodemailer from 'nodemailer'

export type DocHubReminderEmail = {
  signerName: string
  signerEmail: string
  documentTitle: string
  senderName: string
}

export function docHubReminderEmailText(input: DocHubReminderEmail) {
  const signerName = input.signerName.trim() || 'Signatory'
  const documentTitle = input.documentTitle.trim() || 'the document'
  const senderName = input.senderName.trim() || 'the document sender'
  return [
    `Hi ${signerName},`,
    '',
    `This is a reminder that ${documentTitle} is still awaiting your signature in DocHub.`,
    '',
    'Please open the original DocHub signature-request email you received and complete the document using its secure signing link.',
    'If you have already signed very recently, no action is needed.',
    '',
    `Reminder sent by ${senderName} through BA Client Ops Tracker.`,
  ].join('\n')
}

export function docHubReminderMailer() {
  const host = process.env.SMTP_HOST?.trim()
  const from = process.env.SMTP_FROM?.trim()
  const port = Number(process.env.SMTP_PORT || 587)
  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) return null
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465
  const transport = nodemailer.createTransport({
    host, port, secure,
    requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true,
  })
  return async (input: DocHubReminderEmail) => {
    await transport.sendMail({
      from,
      to: { name: input.signerName.trim(), address: input.signerEmail.trim() },
      subject: `Signature reminder: ${input.documentTitle}`.slice(0, 200),
      text: docHubReminderEmailText(input),
    })
  }
}
