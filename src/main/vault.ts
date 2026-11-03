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

  private read(): Record<string, unknown> {
    try {
      if (this.crypto.available() && existsSync(this.encFile)) return JSON.parse(this.crypto.decrypt(readFileSync(this.encFile))) as Record<string, unknown>
      if (existsSync(this.plainFile)) return JSON.parse(readFileSync(this.plainFile, 'utf8')) as Record<string, unknown>
    } catch {
      /* unreadable or undecryptable: treat as empty rather than crash */
    }
    return {}
  }

  private write(map: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true })
    const json = JSON.stringify(map)
    const [file, data, other] = this.crypto.available() ? [this.encFile, this.crypto.encrypt(json), this.plainFile] : [this.plainFile, json, this.encFile]
    const tmp = `${file}.tmp`
    writeFileSync(tmp, data, { mode: 0o600 })
    renameSync(tmp, file)
    if (existsSync(other)) unlinkSync(other)
  }

  get<T = unknown>(key: string): T | undefined {
    return this.read()[key] as T | undefined
  }
  set(key: string, value: unknown): void {
    const m = this.read()
    m[key] = value
    this.write(m)
  }
  delete(key: string): void {
    const m = this.read()
    if (key in m) {
      delete m[key]
      this.write(m)
    }
  }
}
