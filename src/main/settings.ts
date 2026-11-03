import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings, SettingsView } from '../shared/types'

export interface SecretCrypto {
  available(): boolean
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://api.mistral.ai/v1',
  model: 'mistral-medium-latest',
  vibePath: '',
  vibeHome: '',
  mcpServers: [],
  recentFolders: []
}

function atomicWrite(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

/**
 * Settings live in <dir>/settings.json. The API key is kept in a separate file, encrypted with the
 * OS keychain (Electron safeStorage) when available; otherwise it is stored with 0600 permissions
 * and the UI is told so. MISTRAL_API_KEY in the environment always wins and is never written.
 */
export class SettingsStore {
  private cache: Settings
  constructor(
    private dir: string,
    private crypto: SecretCrypto,
    private env: NodeJS.ProcessEnv = process.env
  ) {
    this.cache = this.load()
  }

  private get file(): string {
    return join(this.dir, 'settings.json')
  }
  private get keyFile(): string {
    return join(this.dir, this.crypto.available() ? 'api-key.enc' : 'api-key.txt')
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      return { ...DEFAULT_SETTINGS, ...raw }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  get(): Settings {
    return this.cache
  }

  update(patch: Partial<Settings>): Settings {
    this.cache = { ...this.cache, ...patch }
    atomicWrite(this.file, JSON.stringify(this.cache, null, 2), 0o644)
    return this.cache
  }

  getApiKey(): string | undefined {
    if (this.env.MISTRAL_API_KEY) return this.env.MISTRAL_API_KEY
    try {
      if (this.crypto.available() && existsSync(join(this.dir, 'api-key.enc'))) {
        return this.crypto.decrypt(readFileSync(join(this.dir, 'api-key.enc')))
      }
      if (existsSync(join(this.dir, 'api-key.txt'))) return readFileSync(join(this.dir, 'api-key.txt'), 'utf8').trim() || undefined
    } catch {
      /* unreadable or undecryptable key counts as missing */
    }
    return undefined
  }

  setApiKey(key: string): void {
    const k = key.trim()
    if (!k) return
    this.clearApiKey()
    atomicWrite(this.keyFile, this.crypto.available() ? this.crypto.encrypt(k) : k)
  }

  clearApiKey(): void {
    for (const f of ['api-key.enc', 'api-key.txt']) {
      try {
        unlinkSync(join(this.dir, f))
      } catch {
        /* not stored */
      }
    }
  }

  view(): SettingsView {
    return { ...this.cache, hasApiKey: !!this.getApiKey(), insecureKeyStorage: !this.crypto.available() }
  }
}
