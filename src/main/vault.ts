import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretCrypto } from './settings'

/**
 * Small encrypted key/value store for secrets (extension settings marked sensitive, OAuth tokens).
 * Uses the OS keychain through `crypto` when available; otherwise a 0600 JSON file.
 */
export class SecretVault {
  constructor(
    private dir: string,
    private crypto: SecretCrypto
  ) {}

  private get encFile(): string {
    return join(this.dir, 'vault.enc')
  }
  private get plainFile(): string {
    return join(this.dir, 'vault.json')
  }

  private async read(): Promise<Record<string, unknown>> {
    try {
      const available = await this.crypto.available()
      if (available && existsSync(this.encFile)) return JSON.parse(await this.crypto.decrypt(readFileSync(this.encFile))) as Record<string, unknown>
      if (existsSync(this.plainFile)) return JSON.parse(readFileSync(this.plainFile, 'utf8')) as Record<string, unknown>
    } catch {
      /* unreadable or undecryptable: treat as empty rather than crash */
    }
    return {}
  }

  private async write(map: Record<string, unknown>): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const json = JSON.stringify(map)
    const available = await this.crypto.available()
    const [file, data, other] = available ? [this.encFile, await this.crypto.encrypt(json), this.plainFile] : [this.plainFile, json, this.encFile]
    const tmp = `${file}.tmp`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
    if (existsSync(other)) unlinkSync(other)
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const m = await this.read()
    return m[key] as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    const m = await this.read()
    m[key] = value
    await this.write(m)
  }
  async delete(key: string): Promise<void> {
    const m = await this.read()
    if (key in m) {
      delete m[key]
      await this.write(m)
    }
  }
}
