import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Vibe's browser sign-in stores the key it mints (vibe/utils/keyring.py, setup/auth/api_key_persistence.py). */
export const VIBE_KEYRING_SERVICE = 'ai.mistral.vibe'
export const VIBE_KEY_NAME = 'MISTRAL_API_KEY'

/** Minimal .env parser: KEY=value, optional `export`, optional single/double quotes, # comments. */
export function parseDotenvValue(text: string, name: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || m[1] !== name) continue
    let v = (m[2] ?? '').trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    return v || undefined
  }
  return undefined
}

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? undefined : stdout.replace(/\r?\n$/, '') || undefined))
  })
}

/**
 * Reads the API key Vibe stored after a browser sign-in: the OS keychain first (macOS Keychain, or the
 * Secret Service on Linux), then the plaintext ~/.vibe/.env fallback. Windows' credential store is not
 * read; there the .env fallback is the only source. Returns undefined when nothing is found.
 */
export async function readVibeApiKey(vibeHome: string): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    const k = await run('/usr/bin/security', ['find-generic-password', '-s', VIBE_KEYRING_SERVICE, '-a', VIBE_KEY_NAME, '-w'])
    if (k) return k
  } else if (process.platform === 'linux') {
    const k = await run('secret-tool', ['lookup', 'service', VIBE_KEYRING_SERVICE, 'username', VIBE_KEY_NAME])
    if (k) return k
  }
  const home = vibeHome.trim() || process.env.VIBE_HOME || join(homedir(), '.vibe')
  const envFile = join(home, '.env')
  try {
    if (existsSync(envFile)) return parseDotenvValue(readFileSync(envFile, 'utf8'), VIBE_KEY_NAME)
  } catch {
    /* unreadable: treated as missing */
  }
  return undefined
}
