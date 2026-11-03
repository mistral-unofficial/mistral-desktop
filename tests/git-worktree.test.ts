import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorktree, describeWorktree, removeWorktree } from '../src/main/code/git-worktree'

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'md-wt-')))
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()

function repo(): string {
  const dir = tmp()
  g(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one')
  g(dir, 'add', '.')
  g(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('git worktrees', () => {
  it('creates a worktree on a new branch, describes it, and the main checkout is not one', async () => {
    const r = repo()
    const base = tmp()
    const wt = await createWorktree(r, 'feature/login', base)
    if (!wt.ok) throw new Error(wt.error)
    expect(wt.path.startsWith(base)).toBe(true)
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true)
    expect(g(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/login')
    expect(await describeWorktree(wt.path)).toEqual({ branch: 'feature/login', mainRepo: r })
    expect(await describeWorktree(r)).toBeUndefined()
    expect(await describeWorktree(tmp())).toBeUndefined() // not a repository at all
  })

  it('checks out an existing branch, and refuses a duplicate folder, a bad name, a checked-out branch and a non-repository', async () => {
    const r = repo()
    const base = tmp()
    g(r, 'branch', 'existing')
    const ok = await createWorktree(r, 'existing', base)
    expect(ok.ok).toBe(true)
    expect(await createWorktree(r, 'existing', base)).toMatchObject({ ok: false }) // same folder already there
    expect(await createWorktree(r, 'bad name~', base)).toEqual({ ok: false, error: '"bad name~" is not a valid branch name.' })
    expect(await createWorktree(r, '  ', base)).toEqual({ ok: false, error: 'Enter a branch name.' })
    expect(await createWorktree(r, 'main', base)).toMatchObject({ ok: false }) // main is checked out in the repository
    expect(await createWorktree(tmp(), 'x', base)).toEqual({ ok: false, error: 'This folder is not a git repository.' })
  })

  it('creating from inside a worktree adds a sibling worktree of the same repository', async () => {
    const r = repo()
    const base = tmp()
    const a = await createWorktree(r, 'a', base)
    if (!a.ok) throw new Error(a.error)
    writeFileSync(join(a.path, 'b.txt'), 'two')
    g(a.path, 'add', '.')
    g(a.path, 'commit', '-q', '-m', 'on a')
    const b = await createWorktree(a.path, 'b', base)
    if (!b.ok) throw new Error(b.error)
    expect(existsSync(join(b.path, 'b.txt'))).toBe(true) // started from a's HEAD
    expect((await describeWorktree(b.path))?.mainRepo).toBe(r)
    expect(g(r, 'worktree', 'list')).toContain(b.path)
  })

  it('removes a clean worktree, keeps the branch, and asks before discarding changes', async () => {
    const r = repo()
    const base = tmp()
    const wt = await createWorktree(r, 'work', base)
    if (!wt.ok) throw new Error(wt.error)
    writeFileSync(join(wt.path, 'dirty.txt'), 'x')
    const refused = await removeWorktree(wt.path, false)
    expect(refused).toEqual({ ok: false, dirty: true, error: 'The worktree has uncommitted changes.' })
    expect(existsSync(wt.path)).toBe(true)
    expect(await removeWorktree(wt.path, true)).toEqual({ ok: true })
    expect(existsSync(wt.path)).toBe(false)
    expect(g(r, 'branch', '--list', 'work')).toContain('work')
    const clean = await createWorktree(r, 'other', base)
    if (!clean.ok) throw new Error(clean.error)
    expect(await removeWorktree(clean.path, false)).toEqual({ ok: true })
    expect(await removeWorktree(r, true)).toEqual({ ok: false, error: 'This folder is not a linked git worktree.' })
  })
})
