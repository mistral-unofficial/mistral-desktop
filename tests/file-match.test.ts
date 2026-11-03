import { describe, expect, it } from 'vitest'
import { type FileEntry, fuzzyScore, highlightIndices, matchEntries, sortEntries } from '../src/renderer/src/fileMatch'

const files = (...p: string[]): FileEntry[] => p.map((path) => ({ path, kind: 'file' as const }))
const dirs = (...p: string[]): FileEntry[] => p.map((path) => ({ path, kind: 'folder' as const }))
const names = (r: FileEntry[]): string[] => r.map((e) => e.path)

describe('fuzzyScore (port of vibe fuzzy.rs)', () => {
  it('returns null when the pattern does not match and 0 for an empty pattern', () => {
    expect(fuzzyScore('xyz', 'abc')).toBeNull()
    expect(fuzzyScore('', 'abc')).toBe(0)
    expect(fuzzyScore('longerpattern', 'short')).toBeNull()
  })
  it('ranks prefix > word boundary > consecutive > scattered subsequence', () => {
    const prefix = fuzzyScore('app', 'app.ts')!
    const boundary = fuzzyScore('app', 'src/my-app.ts')!
    const consecutive = fuzzyScore('app', 'src/mapper.ts')!
    const scattered = fuzzyScore('app', 'a_big_pipeline.ts')!
    expect(prefix).toBeGreaterThan(boundary)
    expect(boundary).toBeGreaterThan(consecutive)
    expect(consecutive).toBeGreaterThan(scattered)
  })
  it('is case-insensitive but rewards exact case', () => {
    expect(fuzzyScore('App', 'App.ts')!).toBeGreaterThan(fuzzyScore('app', 'App.ts')!)
    expect(fuzzyScore('APP', 'app.ts')).not.toBeNull()
  })
  it('matches camelCase humps as word boundaries', () => {
    expect(fuzzyScore('fb', 'FooBar.ts')).not.toBeNull()
    expect(fuzzyScore('fb', 'FooBar.ts')!).toBeGreaterThan(fuzzyScore('fb', 'fxxxxxxxxxxxxb.ts')!)
  })
})

describe('matchEntries', () => {
  const tree = sortEntries([
    ...dirs('src', 'src/components', 'docs', '.github'),
    ...files('README.md', 'package.json', 'package-lock.json', '.gitignore', 'src/app.ts', 'src/index.ts', 'src/components/Button.tsx', 'src/components/App.tsx', 'docs/app.md', '.github/ci.yml')
  ])
  it('an empty query lists the top level, without hidden entries', () => {
    expect(names(matchEntries(tree, ''))).toEqual(['docs', 'package-lock.json', 'package.json', 'README.md', 'src'].sort((a, b) => (a < b ? -1 : 1)))
  })
  it('lists a folder with a trailing slash (immediate children only)', () => {
    expect(names(matchEntries(tree, 'src/')).sort()).toEqual(['src/app.ts', 'src/components', 'src/index.ts'])
    expect(names(matchEntries(tree, 'src/components/')).sort()).toEqual(['src/components/App.tsx', 'src/components/Button.tsx'])
  })
  it('fuzzy-searches the whole tree and ranks file-name matches first', () => {
    const r = names(matchEntries(tree, 'app'))
    expect(r[0]).toBe('src/app.ts') // exact stem, shallow
    expect(r).toContain('docs/app.md')
    expect(r).toContain('src/components/App.tsx')
    expect(r.indexOf('src/app.ts')).toBeLessThan(r.indexOf('src/components/App.tsx'))
  })
  it('prefers an exact file name and breaks ties by shallower paths', () => {
    expect(names(matchEntries(tree, 'package.json'))[0]).toBe('package.json')
    expect(names(matchEntries(tree, 'index'))[0]).toBe('src/index.ts')
  })
  it('finds files by scattered letters', () => {
    expect(names(matchEntries(tree, 'btn'))).toContain('src/components/Button.tsx')
    expect(names(matchEntries(tree, 'scb'))).toContain('src/components/Button.tsx')
  })
  it('shows hidden entries only when the query starts with a dot', () => {
    expect(names(matchEntries(tree, 'ci'))).toContain('.github/ci.yml') // like the Vibe CLI: only an entry's own name decides
    expect(names(matchEntries(tree, '.git'))).toEqual(expect.arrayContaining(['.github', '.gitignore']))
    expect(names(matchEntries(tree, 'gitignore'))).not.toContain('.gitignore')
  })
  it('respects the limit and returns kinds', () => {
    const many = sortEntries(files(...Array.from({ length: 50 }, (_, i) => `f${i}.ts`)))
    expect(matchEntries(many, 'f', 8)).toHaveLength(8)
    expect(matchEntries(tree, 'src')[0]).toEqual({ path: 'src', kind: 'folder' })
  })
  it('falls back to fuzzy search when a typed "folder/" is not a real folder', () => {
    expect(names(matchEntries(tree, 'components/'))).toContain('src/components/App.tsx')
  })
  it('returns nothing for no match', () => {
    expect(matchEntries(tree, 'zzzzqq')).toEqual([])
  })
})

describe('highlightIndices', () => {
  it('marks the characters that matched', () => {
    expect([...highlightIndices('app', 'src/app.ts')].sort()).toEqual([4, 5, 6])
    expect([...highlightIndices('', 'x')]).toEqual([])
    expect(highlightIndices('btn', 'src/Button.tsx').size).toBe(3)
  })
})
