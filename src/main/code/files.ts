import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { augmentedPath } from './paths'

export interface ProjectEntry {
  path: string
  kind: 'file' | 'folder'
}

export interface ProjectFiles {
  entries: ProjectEntry[]
  /** The listing hit the entry limit, so some files are missing. */
  truncated: boolean
}

export const MAX_ENTRIES = 50_000

/** Directories never worth listing when a folder is not a git repository. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'out', 'target', '.next', '.cache', '.gradle', '.tox'])

/** Tracked and untracked-but-not-ignored files below `cwd`, or undefined if `cwd` is not in a git repository. */
function gitFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath(), GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => done(err ? undefined : stdout.split('\0').filter(Boolean))
    )
  })
}

/** Breadth-first walk with a cap. Symlinks are listed as files and never followed. */
function walk(cwd: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = []
  const queue: string[] = ['']
  while (queue.length) {
    const rel = queue.shift()!
    let items
    try {
      items = readdirSync(join(cwd, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const it of items) {
      const p = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name)) queue.push(p)
      } else {
        if (files.length >= limit) return { files, truncated: true }
        files.push(p)
      }
    }
  }
  return { files, truncated: false }
}

export async function listProjectFiles(cwd: string, limit = MAX_ENTRIES): Promise<ProjectFiles> {
  let files = await gitFiles(cwd)
  let truncated = false
  if (!files) ({ files, truncated } = walk(cwd, limit))
  if (files.length > limit) {
    files = files.slice(0, limit)
    truncated = true
  }
  const folders = new Set<string>()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i !== -1) {
      folders.add(f.slice(0, i))
      i = f.indexOf('/', i + 1)
    }
  }
  const entries: ProjectEntry[] = [...[...folders].map((path) => ({ path, kind: 'folder' as const })), ...files.map((path) => ({ path: path.replace(/\\/g, '/'), kind: 'file' as const }))]
  return { entries, truncated }
}
