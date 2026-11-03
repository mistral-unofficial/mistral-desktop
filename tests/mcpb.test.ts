import { strToU8, zipSync } from 'fflate'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BundleError, LIMITS, idFromName, normalizeUserConfig, parseBundle, safeEntryName } from '../src/main/mcpb/bundle'
import { ExtensionStore } from '../src/main/mcpb/store'
import { McpHost } from '../src/main/mcp/host'
import { SecretVault } from '../src/main/vault'
import { makeBundle, manifest } from './mcpb-helpers'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'md-mcpb-'))
const crypto = { available: async () => true, encrypt: async (s: string) => Buffer.from('ENC' + Buffer.from(s).toString('base64')), decrypt: async (b: Buffer) => Buffer.from(b.toString().slice(3), 'base64').toString() }

function store(opts: { hasCommand?: (c: string) => boolean } = {}) {
  const dir = tmp()
  const home = tmp()
  mkdirSync(join(home, 'docs'))
  const vault = new SecretVault(join(dir, 'v'), crypto)
  const s = new ExtensionStore(join(dir, 'ext'), vault, { systemDirs: () => ({ HOME: home, DESKTOP: home, DOCUMENTS: home, DOWNLOADS: home }), execPath: process.execPath, hasCommand: opts.hasCommand ?? (() => true) })
  return { s, dir, home, vault }
}

describe('ExtensionStore', () => {
  it('previews with resolved defaults, then installs and resolves the server config', async () => {
    const { s, dir, home, vault } = store()
    const pv = await s.preview(makeBundle())
    expect(pv).toMatchObject({ id: 'demo-ext', displayName: 'Demo Extension', serverType: 'node', signed: false })
    expect(pv.defaults).toEqual({ greeting: 'hello', folder: join(home, 'docs') })
    expect(pv.tools).toEqual([{ name: 'info', description: 'Report config' }])

    const bad = await s.install(pv.stagingId, {})
    expect(bad).toMatchObject({ ok: false, fieldErrors: { api_key: 'Required' } })
    const res = await s.install(pv.stagingId, { api_key: 'sk-secret' })
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'ext', 'demo-ext', 'server', 'index.js'))).toBe(true)

    // secrets never touch extensions.json; they are in the (encrypted) vault
    expect(readFileSync(join(dir, 'ext', 'extensions.json'), 'utf8')).not.toContain('sk-secret')
    expect(readFileSync(join(dir, 'v', 'vault.enc'), 'utf8')).not.toContain('sk-secret')
    expect(await vault.get('ext:demo-ext')).toEqual({ api_key: 'sk-secret' })

    const listed = (await s.list())[0]!
    expect(listed).toMatchObject({ id: 'demo-ext', enabled: true, missingRequired: [], secretKeys: ['api_key'] })
    expect(JSON.stringify(listed)).not.toContain('sk-secret')

    const [cfg] = await s.servers()
    expect(cfg).toMatchObject({ id: 'ext:demo-ext', name: 'demo-ext', enabled: true, command: 'node', extensionId: 'demo-ext', cwd: join(dir, 'ext', 'demo-ext') })
    expect(cfg!.args).toEqual([join(dir, 'ext', 'demo-ext', 'server', 'index.js'), join(home, 'docs')])
    expect(cfg!.env).toEqual({ GREETING: 'hello', SECRET: 'sk-secret' })
  })

  it('runs the installed server end to end through McpHost', async () => {
    const { s } = store()
    const pv = await s.preview(makeBundle())
    expect((await s.install(pv.stagingId, { api_key: 'sk-1', greeting: 'hi there' })).ok).toBe(true)
    const host = new McpHost()
    await host.sync(await s.servers())
    expect(host.status()).toMatchObject([{ name: 'demo-ext', state: 'connected', tools: ['info'], extensionId: 'demo-ext' }])
    const r = await host.call('demo-ext__info', {})
    const info = JSON.parse(r.text)
    expect(info).toMatchObject({ greeting: 'hi there', secret: 'sk-1' })
    expect(info.cwd).toContain('demo-ext')
    await host.shutdown()
  }, 20000)

  it('keeps a stored secret on update when the field is left empty, and reports the previous version', async () => {
    const { s } = store()
    await s.install((await s.preview(makeBundle())).stagingId, { api_key: 'keep-me' })
    const pv2 = await s.preview(makeBundle({ manifest: manifest({ version: '2.0.0' }) }))
    expect(pv2.previous).toMatchObject({ version: '1.0.0', secretKeys: ['api_key'] })
    expect((await s.install(pv2.stagingId, { api_key: '' })).ok).toBe(true)
    expect((await s.list())[0]).toMatchObject({ version: '2.0.0', missingRequired: [] })
  })

  it('configure validates, disable hides the server, uninstall removes everything', async () => {
    const { s, dir, vault } = store()
    await s.install((await s.preview(makeBundle())).stagingId, { api_key: 'k' })
    expect(await s.configure('demo-ext', { folder: '/definitely/not/here' })).toMatchObject({ ok: false, fieldErrors: { folder: expect.stringContaining('not found') } })
    expect((await s.configure('demo-ext', { greeting: 'yo' })).ok).toBe(true)
    expect((await s.servers())[0]!.env.GREETING).toBe('yo')
    s.setEnabled('demo-ext', false)
    expect((await s.servers())[0]!.enabled).toBe(false)
    await s.uninstall('demo-ext')
    expect(await s.list()).toEqual([])
    expect(existsSync(join(dir, 'ext', 'demo-ext'))).toBe(false)
    expect(await vault.get('ext:demo-ext')).toBeUndefined()
  })

  it('does not start an extension whose required setting went missing, and reports it as needing setup', async () => {
    const { s, vault } = store()
    await s.install((await s.preview(makeBundle())).stagingId, { api_key: 'k' })
    expect((await s.servers())[0]).toMatchObject({ enabled: true, command: 'node' })
    await vault.delete('ext:demo-ext') // e.g. the keychain entry was lost
    expect((await s.list())[0]).toMatchObject({ missingRequired: ['api_key'], secretKeys: [] })
    expect((await s.servers())[0]).toMatchObject({ id: 'ext:demo-ext', enabled: false, command: '' })
    expect((await s.configure('demo-ext', { api_key: 'new' })).ok).toBe(true)
    expect((await s.servers())[0]).toMatchObject({ enabled: true })
  })

  it('falls back to the bundled Node runtime when no node is installed, and python3 for python', async () => {
    const { s } = store({ hasCommand: () => false })
    await s.install((await s.preview(makeBundle())).stagingId, { api_key: 'k' })
    const [cfg] = await s.servers()
    expect(cfg).toMatchObject({ command: process.execPath })
    expect(cfg!.env.ELECTRON_RUN_AS_NODE).toBe('1')

    const py = manifest({ name: 'py-ext', server: { type: 'python', entry_point: 'server/main.py', mcp_config: { command: 'python', args: ['${__dirname}/server/main.py'] } }, user_config: undefined })
    const s2 = store({ hasCommand: (c) => c === 'python3' }).s
    await s2.install((await s2.preview(makeBundle({ manifest: py, files: { 'server/main.py': 'print(1)' } }))).stagingId, {})
    expect((await s2.servers())[0]!.command).toBe('python3')
  })

  it('a failed update leaves the old version in place and no staging dirs behind', async () => {
    const { s, dir } = store()
    await s.install((await s.preview(makeBundle())).stagingId, { api_key: 'k' })
    expect(await s.install('expired-id', {})).toMatchObject({ ok: false })
    expect(readdirSync(join(dir, 'ext')).filter((n) => n.startsWith('.staging'))).toEqual([])
    expect(statSync(join(dir, 'ext', 'demo-ext')).isDirectory()).toBe(true)
  })
})
