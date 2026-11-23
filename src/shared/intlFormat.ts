/**
 * Date formatters, made once per locale and options. Making an Intl.DateTimeFormat costs about 50 times more than
 * using one, and lists format a date per row on every render, so formatters are kept and reused.
 */
const formats = new Map<string, Intl.DateTimeFormat>()

export function dateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale || ''}|${JSON.stringify(options)}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options)
    formats.set(key, format)
  }
  return format
}
