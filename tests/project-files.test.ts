import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listProjectFiles } from '../src/main/code/files'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'md-files-'))
const put = (root: string, rel: string, data: string | Buffer = 'x'): void => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), data)
}
const paths = (r: { entries: { path: string; kind: string }[] }, kind: string): string[] => r.entries.filter((e) => e.kind === kind).map((e) => e.path).sort()

describe('listProjectFiles', () => {
  it('in a git repo: tracked and untracked files, not ignored ones; folders derived; odd names intact', async () => {
    const d = tmp()
    execFileSync('git', ['init', '-q'], { cwd: d })
    put(d, 'tracked.txt')
    put(d, '.gitignore', '*.log\nbuild/\n')
    put(d, 'new.txt')
    put(d, 'debug.log')
    put(d, 'build/out.js')
    put(d, 'src/deep/mod.ts')
    put(d, 'dir with space/file name.txt')
    put(d, 'é.txt')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: d })
    const r = await listProjectFiles(d)
    expect(paths(r, 'file')).toEqual(['.gitignore', 'dir with space/file name.txt', 'new.txt', 'src/deep/mod.ts', 'tracked.txt', 'é.txt'])
    expect(paths(r, 'folder')).toEqual(['dir with space', 'src', 'src/deep'])
    expect(r.truncated).toBe(false)
  })

  it('lists only the subfolder when started inside one', async () => {
    const d = tmp()
    execFileSync('git', ['init', '-q'], { cwd: d })
    put(d, 'top.txt')
    put(d, 'pkg/a.txt')
    const r = await listProjectFiles(join(d, 'pkg'))
    expect(paths(r, 'file')).toEqual(['a.txt'])
  })

  it('without git: walks the folder, skipping dependency/build directories, not following symlinks', async () => {
    const d = tmp()
    put(d, 'a.txt')
    put(d, 'src/b.ts')
    put(d, 'node_modules/pkg/index.js')
    put(d, '.git/config')
    put(d, '.venv/lib/x.py')
    put(d, '.hidden/c.txt')
    const outside = tmp()
    put(outside, 'secret.txt')
    symlinkSync(outside, join(d, 'linkdir'))
    const r = await listProjectFiles(d)
    expect(paths(r, 'file')).toEqual(['.hidden/c.txt', 'a.txt', 'linkdir', 'src/b.ts'])
    expect(paths(r, 'folder')).toEqual(['.hidden', 'src'])
  })

  it('stops at the limit and says so', async () => {
    const d = tmp()
    for (let i = 0; i < 30; i++) put(d, `f${i}.txt`)
    const r = await listProjectFiles(d, 10)
    expect(r.entries.filter((e) => e.kind === 'file')).toHaveLength(10)
    expect(r.truncated).toBe(true)
  })

  it('an empty folder gives an empty list', async () => {
    expect(await listProjectFiles(tmp())).toEqual({ entries: [], truncated: false })
  })
})
