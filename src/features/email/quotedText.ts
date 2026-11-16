/**
 * Splits an email body into the new text and the earlier messages it quotes ("On Mon, … wrote:" followed by "> …"
 * lines, or an Outlook "From: … Sent: …" header), so a thread shows each reply once and the quoted history folds away.
 * When nothing is new (the whole body is a quote), nothing is folded.
 */
export function splitQuoted(body: string): { main: string; quoted: string } {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const at = (index: number) => (lines[index] || '').trim()
  let cut = -1
  for (let index = 0; index < lines.length && cut < 0; index++) {
    const line = at(index)
    if (/^on\b.*\bwrote:$/i.test(line)) cut = index
    // Gmail wraps a long "On …, Name <" line before "email> wrote:".
    else if (/^on\b/i.test(line) && /\bwrote:$/i.test(at(index + 1)) && !at(index + 1).startsWith('>')) cut = index
    else if (/^-{2,}\s*original message\s*-{2,}$/i.test(line)) cut = index
    else if (/^from:\s.+/i.test(line) && [1, 2, 3].some(step => /^(sent|date):\s/i.test(at(index + step)))) cut = index
    else if (line.startsWith('>') && at(index + 1).startsWith('>')) cut = index
  }
  if (cut <= 0) return { main: body.trim(), quoted: '' }
  const main = lines.slice(0, cut).join('\n').trim()
  if (!main) return { main: body.trim(), quoted: '' }
  return { main, quoted: lines.slice(cut).join('\n').trim() }
}
