import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore, type SecretCrypto } from '../src/main/settings'

const fakeCrypto = (available: boolean): SecretCrypto => ({
  available: async () => available,
  encrypt: async (s) => Buffer.from('ENC:' + s.split('').reverse().join('')),
  decrypt: async (b) => b.toString().slice(4).split('').reverse().join('')
})
const tmp = (): string => mkdtempSync(join(tmpdir(), 'md-settings-'))

describe('SettingsStore', () => {
  it('persists settings across instances and merges defaults', () => {
    const d = tmp()
    new SettingsStore(d, fakeCrypto(true), {}).update({ model: 'x' })
    const s = new SettingsStore(d, fakeCrypto(true), {})
    expect(s.get().model).toBe('x')
    expect(s.get().apiBase).toContain('api.mistral.ai')
  })
  it('encrypts the key and never writes it into settings.json', async () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(true), {})
    s.update({ model: 'm' })
    await s.setApiKey('  sk-secret ')
    expect(readFileSync(join(d, 'settings.json'), 'utf8').includes('sk-secret')).toBe(false)
    expect(readdirSync(d)).toContain('api-key.enc')
    expect(readFileSync(join(d, 'api-key.enc'), 'utf8')).not.toContain('sk-secret')
    expect(await new SettingsStore(d, fakeCrypto(true), {}).getApiKey()).toBe('sk-secret')
    expect(await s.view()).toMatchObject({ hasApiKey: true, insecureKeyStorage: false })
    expect(JSON.stringify(await s.view())).not.toContain('sk-secret')
  })
  it('falls back to a 0600 file and flags it when no keychain', async () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(false), {})
    await s.setApiKey('k1')
    expect((await s.view()).insecureKeyStorage).toBe(true)
    expect(readdirSync(d)).toContain('api-key.txt')
  })
  it('env key wins; clear removes stored key', async () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(true), { MISTRAL_API_KEY: 'envkey' })
    await s.setApiKey('stored')
    expect(await s.getApiKey()).toBe('envkey')
    const s2 = new SettingsStore(d, fakeCrypto(true), {})
    expect(await s2.getApiKey()).toBe('stored')
    s2.clearApiKey()
    expect(await s2.getApiKey()).toBeUndefined()
    expect((await s2.view()).hasApiKey).toBe(false)
  })
  it('ignores an empty key', async () => {
    const s = new SettingsStore(tmp(), fakeCrypto(true), {})
    await s.setApiKey('   ')
    expect(await s.getApiKey()).toBeUndefined()
  })
})
