import nodemailer from 'nodemailer'

export const recoveryMessage = 'If those details match an active account, a password reset link will be emailed to you. Check your inbox and spam folder.'
export const recoveryUnavailable = 'Email recovery is unavailable. Please contact your administrator.'

export function validRecoveryEmail(value: string) {
  return value.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)
}

export function recoveryMailer() {
  const host = process.env.SMTP_HOST?.trim()
  const from = process.env.SMTP_FROM?.trim()
  const base = process.env.APP_BASE_URL?.trim()
  const port = Number(process.env.SMTP_PORT || 587)
  if (!host || !from || !base || !Number.isInteger(port) || port < 1 || port > 65535) return null
  let baseUrl: URL
  try { baseUrl = new URL(base) } catch { return null }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback)) return null
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return null
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465
  const transport = nodemailer.createTransport({
    host, port, secure,
    requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    disableFileAccess: true, disableUrlAccess: true,
  })
  return async (email: string, account: string, token: string) => {
    const link = new URL(baseUrl)
    link.hash = `reset-password=${token}`
    await transport.sendMail({
      from, to: { name: '', address: email }, subject: 'Reset your Client Ops Tracker password',
      text: `A password reset was requested for your ${account} account.\n\nChoose a new password using this link:\n${link.href}\n\nThis link expires in 30 minutes and can be used once. Requesting another link replaces this one.\n\nIf you did not request this, ignore this email. Your password has not changed.`,
    })
  }
}
