import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings, SettingsView } from '../shared/types'

export interface SecretCrypto {
  available(): Promise<boolean>
  encrypt(s: string): Promise<Buffer>
  decrypt(b: Buffer): Promise<string>
}

export const DEFAULT_SETTINGS: Settings = {
  apiBase: 'https://api.mistral.ai/v1',
  model: 'mistral-medium-latest',
  vibePath: '',
  vibeHome: '',
  mcpServers: [],
  recentFolders: [],
  profileName: '',
  profileEmail: ''
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
  private async keyFile(): Promise<string> {
    return join(this.dir, (await this.crypto.available()) ? 'api-key.enc' : 'api-key.txt')
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

  async getApiKey(): Promise<string | undefined> {
    if (this.env.MISTRAL_API_KEY) return this.env.MISTRAL_API_KEY
    try {
      const available = await this.crypto.available()
      if (available && existsSync(join(this.dir, 'api-key.enc'))) {
        return await this.crypto.decrypt(readFileSync(join(this.dir, 'api-key.enc')))
      }
      if (existsSync(join(this.dir, 'api-key.txt'))) return readFileSync(join(this.dir, 'api-key.txt'), 'utf8').trim() || undefined
    } catch {
      /* unreadable or undecryptable key counts as missing */
    }
    return undefined
  }

  async setApiKey(key: string): Promise<void> {
    const k = key.trim()
    if (!k) return
    this.clearApiKey()
    const available = await this.crypto.available()
    const file = await this.keyFile()
    atomicWrite(file, available ? await this.crypto.encrypt(k) : k)
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

  async view(): Promise<SettingsView> {
    const [available, apiKey] = await Promise.all([this.crypto.available(), this.getApiKey()])
    return { ...this.cache, hasApiKey: !!apiKey, insecureKeyStorage: !available }
  }
}
