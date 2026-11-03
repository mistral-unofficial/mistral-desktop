// `@path` file mentions, as the Vibe agent parses them (vibe/core/autocompletion/path_prompt.py).
// Vibe itself attaches the mentioned files to the prompt, so the app only has to complete them in the syntax Vibe understands:
//   - `@` counts as a mention when it is at the start or follows anything but a letter, digit or `_` (so `me@host` is not one);
//   - an unquoted path may only use letters, digits and  . _ / \ - ( ) [ ] { } ~  (no spaces, no other punctuation);
//   - anything else needs quotes: `@"my file.txt"` or `@'a+b.txt'`, with `\"` escaping a quote inside double quotes.
// Pure functions, no imports.

export interface ActiveMention {
  /** Index of the `@`. */
  start: number
  /** End of the token being completed: the end of the path characters after the caret, or the closing quote. */
  end: number
  /** What has been typed after the `@` (and quote), up to the caret. */
  query: string
  quoted: boolean
}

const WORD = /[\p{L}\p{N}_]/u
const isPathChar = (c: string): boolean => /[\p{L}\p{N}._/\\()[\]{}~-]/u.test(c)
const isAnchor = (text: string, i: number): boolean => text[i] === '@' && (i === 0 || !WORD.test(text[i - 1]!))

/** Index just past the closing quote of a quoted mention whose body starts at `from`, or -1 if it is not closed on this line. */
function closingQuote(text: string, from: number, quote: string, limit = text.length): number {
  for (let i = from; i < limit; i++) {
    const c = text[i]!
    if (c === '\n') return -1
    if (c === '\\' && text[i + 1] === quote) i++
    else if (c === quote) return i + 1
  }
  return -1
}

/** The mention being typed at `caret`, if any (the nearest `@` before the caret that Vibe would read as a mention). */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  for (let i = caret - 1; i >= lineStart; i--) {
    if (text[i] !== '@' || !isAnchor(text, i)) continue
    const q = text[i + 1]
    if ((q === '"' || q === "'") && caret >= i + 2) {
      if (closingQuote(text, i + 2, q, caret) !== -1) continue // already closed before the caret
      const close = closingQuote(text, caret, q)
      const body = text.slice(i + 2, caret).split(`\\${q}`).join(q)
      return { start: i, end: close === -1 ? lineEnd(text, caret) : close, query: body, quoted: true }
    }
    const body = text.slice(i + 1, caret)
    if (![...body].every(isPathChar)) continue
    let end = caret
    while (end < text.length && isPathChar(text[end]!)) end++
    return { start: i, end, query: body, quoted: false }
  }
  return null
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from)
  return nl === -1 ? text.length : nl
}

/**
 * What to insert for a completed entry. Folders keep the mention open (no trailing space) so their content can be
 * completed next; files end with a space. Returns undefined for a name that cannot be written as a mention.
 */
export function formatMention(path: string, kind: 'file' | 'folder'): string | undefined {
  // Vibe expands a leading `~` to a home directory; `./` keeps a file literally named like that.
  const p = path.startsWith('~') ? `./${path}` : path
  if ([...p].every(isPathChar)) return kind === 'folder' ? `@${p}/` : `@${p} `
  const quote = !p.includes('"') ? '"' : !p.includes("'") ? "'" : undefined
  if (!quote) return undefined
  return kind === 'folder' ? `@${quote}${p}/` : `@${quote}${p}${quote} `
}
