import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore, type SecretCrypto } from '../src/main/settings'

const fakeCrypto = (available: boolean): SecretCrypto => ({
  available: () => available,
  encrypt: (s) => Buffer.from('ENC:' + s.split('').reverse().join('')),
  decrypt: (b) => b.toString().slice(4).split('').reverse().join('')
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
  it('encrypts the key and never writes it into settings.json', () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(true), {})
    s.update({ model: 'm' })
    s.setApiKey('  sk-secret ')
    expect(readFileSync(join(d, 'settings.json'), 'utf8').includes('sk-secret')).toBe(false)
    expect(readdirSync(d)).toContain('api-key.enc')
    expect(readFileSync(join(d, 'api-key.enc'), 'utf8')).not.toContain('sk-secret')
    expect(new SettingsStore(d, fakeCrypto(true), {}).getApiKey()).toBe('sk-secret')
    expect(s.view()).toMatchObject({ hasApiKey: true, insecureKeyStorage: false })
    expect(JSON.stringify(s.view())).not.toContain('sk-secret')
  })
  it('falls back to a 0600 file and flags it when no keychain', () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(false), {})
    s.setApiKey('k1')
    expect(s.view().insecureKeyStorage).toBe(true)
    expect(readdirSync(d)).toContain('api-key.txt')
  })
  it('env key wins; clear removes stored key', () => {
    const d = tmp()
    const s = new SettingsStore(d, fakeCrypto(true), { MISTRAL_API_KEY: 'envkey' })
    s.setApiKey('stored')
    expect(s.getApiKey()).toBe('envkey')
    const s2 = new SettingsStore(d, fakeCrypto(true), {})
    expect(s2.getApiKey()).toBe('stored')
    s2.clearApiKey()
    expect(s2.getApiKey()).toBeUndefined()
    expect(s2.view().hasApiKey).toBe(false)
  })
  it('ignores an empty key', () => {
    const s = new SettingsStore(tmp(), fakeCrypto(true), {})
    s.setApiKey('   ')
    expect(s.getApiKey()).toBeUndefined()
  })
})
