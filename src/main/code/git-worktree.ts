import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { augmentedPath } from './paths'

/**
 * Git worktrees for Code sessions. Vibe's ACP interface has no worktree support, so the app runs `git worktree`
 * itself and starts the session with the new worktree as its folder.
 */

export type GitResult = { ok: true; out: string } | { ok: false; error: string }

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: augmentedPath(), GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return done({ ok: true, out: stdout.trim() })
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return done({ ok: false, error: 'git is not installed (or not on the PATH).' })
      done({ ok: false, error: (stderr || stdout || e.message).trim().replace(/^fatal: /, '') })
    })
  })
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export interface WorktreeInfo {
  /** Checked-out branch ('(detached)' when HEAD is detached). */
  branch: string
  /** The repository this worktree belongs to. */
  mainRepo: string
}

/** Describes a folder if it is a linked git worktree (not the main checkout); undefined otherwise. */
export async function describeWorktree(folder: string): Promise<WorktreeInfo | undefined> {
  const r = await git(folder, ['rev-parse', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'])
  if (!r.ok) return undefined
  const [gitDir, commonDir, head] = r.out.split('\n')
  if (!gitDir || !commonDir) return undefined
  const abs = (p: string): string => real(isAbsolute(p) ? p : join(folder, p))
  if (abs(gitDir) === abs(commonDir)) return undefined
  return { branch: head && head !== 'HEAD' ? head : '(detached)', mainRepo: dirname(abs(commonDir)) }
}

const slug = (branch: string): string => branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '') || 'worktree'

export type CreateResult = { ok: true; path: string; branch: string } | { ok: false; error: string }

/**
 * Creates a worktree for `branch` of the repository containing `folder`, under `baseDir/<repo>-<hash>/<branch>`.
 * An existing local branch is checked out; otherwise a new branch is created from the folder's current HEAD.
 */
export async function createWorktree(folder: string, branchInput: string, baseDir: string): Promise<CreateResult> {
  const branch = branchInput.trim()
  if (!branch) return { ok: false, error: 'Enter a branch name.' }
  const top = await git(folder, ['rev-parse', '--show-toplevel'])
  if (!top.ok) return { ok: false, error: /not a git repository/i.test(top.error) ? 'This folder is not a git repository.' : top.error }
  // A worktree of a worktree belongs to the same repository: base it on the main one.
  const main = (await describeWorktree(folder))?.mainRepo ?? real(top.out)
  const valid = await git(main, ['check-ref-format', '--branch', branch])
  if (!valid.ok) return { ok: false, error: `"${branch}" is not a valid branch name.` }
  const path = join(baseDir, `${basename(main)}-${createHash('sha1').update(main).digest('hex').slice(0, 8)}`, slug(branch))
  if (existsSync(path)) return { ok: false, error: `A worktree folder for "${branch}" already exists.` }
  mkdirSync(dirname(path), { recursive: true })
  const exists = (await git(main, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok
  // Run from the folder itself so a new branch starts at that checkout's HEAD.
  const here = real(top.out)
  const r = exists ? await git(here, ['worktree', 'add', path, branch]) : await git(here, ['worktree', 'add', '-b', branch, path])
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: real(path), branch }
}

export type RemoveResult = { ok: true } | { ok: false; error: string; dirty?: boolean }

/** Removes a linked worktree. Without `force`, refuses when it holds uncommitted changes. The branch is kept. */
export async function removeWorktree(folder: string, force: boolean): Promise<RemoveResult> {
  const info = await describeWorktree(folder)
  if (!info) return { ok: false, error: 'This folder is not a linked git worktree.' }
  if (!force) {
    const st = await git(folder, ['status', '--porcelain'])
    if (st.ok && st.out) return { ok: false, dirty: true, error: 'The worktree has uncommitted changes.' }
  }
  const r = await git(info.mainRepo, ['worktree', 'remove', ...(force ? ['--force'] : []), folder])
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}
