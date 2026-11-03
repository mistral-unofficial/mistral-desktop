// Fuzzy file matching for `@` completion. A port of Vibe's own scorer and ranking
// (vibe/cli-rust/src/utils/fuzzy.rs and file_match.rs) so results are ordered like in the Vibe CLI.

export interface FileEntry {
  /** Path relative to the project folder, '/'-separated, no trailing slash. */
  path: string
  kind: 'file' | 'folder'
}

const SEP = new Set(['/', '-', '_', '.'])
const isUpper = (c: string | undefined): boolean => c !== undefined && c !== c.toLowerCase() && c === c.toUpperCase()

function isBoundary(lower: string[], orig: string[], i: number): boolean {
  return i === 0 || SEP.has(lower[i - 1]!) || (isUpper(orig[i]) && !isUpper(orig[i - 1]))
}

function calculateScore(patOrig: string[], textOrig: string[], textLower: string[], idx: number[]): number {
  const first = idx[0]
  if (first === undefined) return 0
  let score = first === 0 ? 300 : 200 - first * 4
  for (let k = 1; k < idx.length; k++) score += idx[k] === idx[k - 1]! + 1 ? 20 : -(idx[k]! - idx[k - 1]! - 1) * 3
  idx.forEach((ti, pi) => {
    if (ti === 0 || SEP.has(textLower[ti - 1]!)) score += 10
    else if (isUpper(textOrig[ti]) && !isUpper(textOrig[ti - 1])) score += 6
    if (patOrig[pi] !== undefined && patOrig[pi] === textOrig[ti]) score += 4
  })
  return Math.max(0, score)
}

function wordBoundaryMatch(pat: string[], lower: string[], orig: string[]): number[] | null {
  const idx: number[] = []
  let p = 0
  for (let i = 0; i < lower.length && p < pat.length; i++) {
    if (lower[i] === pat[p] && (isBoundary(lower, orig, i) || idx[idx.length - 1] === i - 1 || idx.length === 0)) {
      idx.push(i)
      p++
    }
  }
  return p === pat.length ? idx : null
}

function consecutiveMatch(pat: string[], lower: string[]): number[] | null {
  let idx: number[] = []
  let p = 0
  for (let i = 0; i < lower.length && p < pat.length; i++) {
    if (lower[i] === pat[p]) {
      idx.push(i)
      p++
    } else if (idx.length) {
      idx = []
      p = 0
    }
  }
  return p === pat.length ? idx : null
}

function subsequenceMatch(pat: string[], lower: string[]): number[] | null {
  const idx: number[] = []
  let p = 0
  for (let i = 0; i < lower.length && p < pat.length; i++) {
    if (lower[i] === pat[p]) {
      idx.push(i)
      p++
    }
  }
  return p === pat.length ? idx : null
}

/** Higher is better; null when `pattern` does not match `text` at all. */
export function fuzzyScore(pattern: string, text: string): number | null {
  if (!pattern) return 0
  const pOrig = [...pattern]
  const pLower = [...pattern.toLowerCase()]
  const tOrig = [...text]
  const tLower = [...text.toLowerCase()]
  if (pLower.length > tLower.length) return null
  if (tLower.slice(0, pLower.length).join('') === pLower.join('')) {
    return calculateScore(pOrig, tOrig, tLower, pLower.map((_, i) => i)) * 20
  }
  const tiers: [number[] | null, number][] = [
    [wordBoundaryMatch(pLower, tLower, tOrig), 18],
    [consecutiveMatch(pLower, tLower), 13],
    [subsequenceMatch(pLower, tLower), 10]
  ]
  let best: number | null = null
  for (const [idx, mult] of tiers) {
    if (!idx) continue
    const s = calculateScore(pOrig, tOrig, tLower, idx) * mult
    if (best === null || s > best) best = s
  }
  return best
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const depth = (p: string): number => p.split('/').length - 1

function splitFilename(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot + 1 === name.length) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

function isImmediateChild(path: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, '') + '/'
  let after: string
  if (path.startsWith(p)) after = path.slice(p.length)
  else {
    const i = path.indexOf(p)
    if (i === -1 || (i > 0 && path[i - 1] !== '/')) return false
    after = path.slice(i + p.length)
  }
  return after !== '' && !after.includes('/')
}

interface Ctx {
  suffix: string
  pattern: string
  prefix: string
  immediateOnly: boolean
}

function context(query: string): Ctx {
  const suffix = query.slice(query.lastIndexOf('/') + 1)
  if (!query) return { suffix, pattern: '', prefix: '', immediateOnly: true }
  if (query.endsWith('/')) return { suffix, pattern: '', prefix: query, immediateOnly: true }
  return { suffix, pattern: query, prefix: '', immediateOnly: false }
}

type Rank = [boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, number, number]

function rank(path: string, isDir: boolean, c: Ctx, fuzzy: number): Rank {
  const query = c.suffix.toLowerCase()
  const name = baseName(path).toLowerCase()
  const relative = path.toLowerCase()
  const [stem, ext] = splitFilename(name)
  const [qStem, qExt] = splitFilename(query)
  const looksLikeFile = query.includes('.')
  const pat = c.pattern.toLowerCase()
  return [
    isDir && relative === pat,
    pat.includes('/') && isImmediateChild(relative, pat),
    looksLikeFile && name === query,
    stem === query && ext !== '.lock',
    stem === query || (looksLikeFile && stem === qStem),
    stem.startsWith(looksLikeFile ? qStem : query),
    name.startsWith(query),
    qExt !== '' && ext === qExt,
    fuzzy,
    -depth(path)
  ]
}

function cmpRank(a: Rank, b: Rank): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    return (a[i] as number | boolean) > (b[i] as number | boolean) ? -1 : 1 // descending
  }
  return 0
}

function ranked(entries: FileEntry[], c: Ctx, limit: number): { path: string; kind: FileEntry['kind']; r: Rank }[] {
  const listing = c.pattern === ''
  const out: { path: string; kind: FileEntry['kind']; r: Rank }[] = []
  const budget = listing ? Infinity : 32_000
  for (let n = 0; n < entries.length && n < budget; n++) {
    const { path, kind } = entries[n]!
    const isDir = kind === 'folder'
    const inContext = c.prefix
      ? !(isDir && path === c.prefix.replace(/\/+$/, '')) && isImmediateChild(path, c.prefix)
      : !c.immediateOnly || !path.includes('/')
    if (!inContext) continue
    if (baseName(path).startsWith('.') && !c.suffix.startsWith('.')) continue // hidden entries only when asked for
    let fuzzy = 0
    if (!listing) {
      const s = fuzzyScore(c.pattern, path)
      if (s === null) continue
      fuzzy = s
    }
    out.push({ path, kind, r: rank(path, isDir, c, fuzzy) })
    if (listing && out.length >= limit) break
  }
  out.sort((a, b) => cmpRank(a.r, b.r) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out.slice(0, limit)
}

/** Sort once so listings are stable and early exit works (the same order Vibe uses). */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Entries matching what was typed after `@`. Empty query lists the top level; `dir/` lists that folder;
 * anything else is a fuzzy search over all paths. `entries` must be sorted with {@link sortEntries}.
 */
export function matchEntries(entries: FileEntry[], query: string, limit = 8): FileEntry[] {
  let res = ranked(entries, context(query), limit)
  if (!res.length && query.endsWith('/')) {
    const prefix = query.replace(/\/+$/, '')
    if (prefix && !entries.some((e) => e.path === prefix && e.kind === 'folder')) res = ranked(entries, { suffix: query.slice(query.lastIndexOf('/') + 1), pattern: query, prefix: '', immediateOnly: false }, limit)
  }
  return res.map(({ path, kind }) => ({ path, kind }))
}

/** Indices of `path` characters matching `query`, for highlighting. Simple left-to-right subsequence, preferring the file name. */
export function highlightIndices(query: string, path: string): Set<number> {
  const out = new Set<number>()
  const q = query.toLowerCase().replace(/\/+$/, '')
  if (!q) return out
  const lower = path.toLowerCase()
  const tryFrom = (from: number): number[] | null => {
    const idx: number[] = []
    let p = 0
    for (let i = from; i < lower.length && p < q.length; i++) if (lower[i] === q[p]) (idx.push(i), p++)
    return p === q.length ? idx : null
  }
  const exact = lower.indexOf(q)
  const idx = exact !== -1 ? Array.from({ length: q.length }, (_, k) => exact + k) : (tryFrom(path.lastIndexOf('/') + 1) ?? tryFrom(0))
  idx?.forEach((i) => out.add(i))
  return out
}
