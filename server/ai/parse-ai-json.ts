/**
 * Reads a JSON object out of a model reply.
 *
 * A reply that is already valid JSON is returned exactly as `JSON.parse` would. Only when that fails does this
 * try, in order: removing code fences, taking the outermost `{ ... }`, and repairing the slips long model
 * replies most often contain (raw line breaks inside strings, trailing commas, unescaped double quotes).
 */
export class AiJsonError extends Error {
  constructor(readonly length: number, readonly position: number | undefined, readonly startsWithBrace: boolean, readonly endsWithBrace: boolean) {
    super('The AI reply could not be read as JSON.')
    this.name = 'AiJsonError'
  }
}

function stripFences(text: string) {
  const trimmed = text.replace(/^﻿/, '').trim()
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(trimmed)
  return (fenced ? fenced[1] : trimmed).trim()
}

function outermostObject(text: string) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/** Next non-whitespace character at or after `from`, with its index. */
function nextSignificant(text: string, from: number) {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  return { char: text[i] as string | undefined, index: i }
}

function repair(text: string) {
  let out = '', inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (!inString) {
      if (c === '"') inString = true
      // A comma directly before a closing bracket is not valid JSON.
      else if (c === ',') { const next = nextSignificant(text, i + 1).char; if (next === '}' || next === ']') continue }
      out += c
      continue
    }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue }
    if (c === '"') {
      // A quote ends the string only when what follows is structural; otherwise it is quoted text, so escape it.
      const next = nextSignificant(text, i + 1)
      let closing = next.char === undefined || next.char === '}' || next.char === ']' || next.char === ':'
      if (next.char === ',') { const after = nextSignificant(text, next.index + 1).char; closing = after === undefined || after === '"' || after === '{' || after === '[' || after === '}' || after === ']' }
      if (closing) { inString = false; out += c } else out += '\\"'
      continue
    }
    if (c === '\r') { if (text[i + 1] !== '\n') out += '\\n'; continue }
    if (c === '\n') out += '\\n'
    else if (c === '\t') out += '\\t'
    else if (c < ' ') out += `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    else out += c
  }
  return out
}

export function parseAiJson(text: string): any {
  const stripped = stripFences(text)
  try { return JSON.parse(stripped) } catch (strictError) {
    const candidate = outermostObject(stripped)
    if (candidate !== stripped) { try { return JSON.parse(candidate) } catch { /* try repairing below */ } }
    try { return JSON.parse(repair(candidate)) } catch {
      const position = Number(/position (\d+)/.exec((strictError as Error).message)?.[1])
      throw new AiJsonError(text.length, Number.isFinite(position) ? position : undefined, stripped.startsWith('{'), stripped.endsWith('}'))
    }
  }
}

export const AI_JSON_RETRY_NOTE = 'IMPORTANT: your previous reply could not be parsed as JSON. Return ONLY one valid JSON object with no text before or after it. Escape every double quote that appears inside a string value as \\" and write every line break inside a string value as \\n.'

/**
 * Runs a generation that must return a JSON object. If the reply is unreadable the generation is run once more
 * with an explicit reminder; provider errors are not retried. Only the length and the shape of the reply are logged,
 * never document text.
 */
export async function runAiJson(run: (extraInstruction: string) => Promise<string>, failure: () => Error, label = 'ai'): Promise<any> {
  const first = await run('')
  try { return parseAiJson(first) } catch (e) {
    if (e instanceof AiJsonError) console.warn(`[${label}] unreadable AI reply, retrying once`, { length: e.length, position: e.position, startsWithBrace: e.startsWithBrace, endsWithBrace: e.endsWithBrace })
  }
  const second = await run(AI_JSON_RETRY_NOTE)
  try { return parseAiJson(second) } catch (e) {
    if (e instanceof AiJsonError) console.warn(`[${label}] unreadable AI reply after retry`, { length: e.length, position: e.position, startsWithBrace: e.startsWithBrace, endsWithBrace: e.endsWithBrace })
    throw failure()
  }
}
