import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Directories where Vibe and tools like git usually are. GUI apps do not inherit the shell PATH, so Homebrew etc. are not on it. */
export function vibeSearchDirs(): string[] {
  if (process.platform === 'win32') return [join(homedir(), '.local', 'bin')]
  return [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']
}

/** PATH for spawned processes: the inherited one plus the usual tool directories. */
export function augmentedPath(base: string | undefined = process.env.PATH): string {
  const parts = (base ?? '').split(delimiter).filter(Boolean)
  for (const d of [...vibeSearchDirs(), '/opt/homebrew/sbin', '/usr/local/sbin']) if (!parts.includes(d)) parts.push(d)
  return parts.join(delimiter)
}
