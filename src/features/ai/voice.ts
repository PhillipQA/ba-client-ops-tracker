/**
 * Voice for the BA Assistant: talking to it (dictation into the question box) and hearing its answers. Both use the
 * browser's own speech features, so they cost no AI tokens and nothing runs on the server. Dictation only fills the
 * box: the person still sends the question, so a misheard sentence never spends tokens by itself.
 *
 * This file holds the parts that need no browser, so they can be tested; useVoice.ts drives the browser.
 */
export const VOICE_LANGS = [
  { code: 'en-PH', label: 'English (Philippines)' },
  { code: 'fil-PH', label: 'Filipino / Taglish' },
  { code: 'en-US', label: 'English (US)' },
] as const
export type VoiceLang = (typeof VOICE_LANGS)[number]['code']
export const cleanVoiceLang = (value: unknown): VoiceLang =>
  VOICE_LANGS.find(lang => lang.code === value)?.code || 'en-PH'

/** The most that is read aloud of one answer, in characters. */
export const SPEAK_LIMIT = 900

/** An answer as it is read aloud: no markdown marks, links by their text, addresses left out, cut at a sentence. */
export function speakable(text: unknown, limit = SPEAK_LIMIT) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?:;])\s*\.(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= limit) return plain
  const cut = plain.slice(0, limit)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return (end > limit / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' '))).trim()
}

/** What was already typed, then what was said. */
export function joinDictation(typed: string, spoken: string) {
  const said = spoken.replace(/\s+/g, ' ').trim()
  const before = typed.trimEnd()
  return before && said ? `${before} ${said}` : before || said
}

type Voice = { lang: string; default?: boolean; localService?: boolean }
/** The voice for a language: that language and country, then the language (Filipino is also listed as Tagalog). */
export function pickVoice<T extends Voice>(voices: T[], lang: string): T | undefined {
  const wanted = lang.toLowerCase().replace('_', '-')
  const language = wanted.split('-')[0]
  const families = language === 'fil' ? ['fil', 'tl'] : [language]
  const of = (voice: T) => voice.lang.toLowerCase().replace('_', '-')
  const best = (list: T[]) => list.find(voice => voice.localService) || list[0]
  return (
    best(voices.filter(voice => of(voice) === wanted)) ||
    best(voices.filter(voice => families.includes(of(voice).split('-')[0])))
  )
}

/** Why dictation stopped, in the person's words; empty for an ordinary stop. */
export function dictationProblem(code: unknown) {
  if (code === 'not-allowed' || code === 'service-not-allowed')
    return 'The microphone is blocked. Allow it for this site in the browser, then try again.'
  if (code === 'audio-capture') return 'No microphone was found.'
  if (code === 'network') return 'Dictation needs an internet connection in this browser.'
  if (code === 'language-not-supported') return 'This browser cannot take dictation in that language.'
  return ''
}
