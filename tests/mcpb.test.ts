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
const crypto = { available: () => true, encrypt: (s: string) => Buffer.from('ENC' + Buffer.from(s).toString('base64')), decrypt: (b: Buffer) => Buffer.from(b.toString().slice(3), 'base64').toString() }

describe('parseBundle', () => {
  it('parses a valid bundle', () => {
    const p = parseBundle(makeBundle())
    expect(p.manifest.name).toBe('demo-ext')
    expect(p.signed).toBe(false)
    expect(p.files.has('server/index.js')).toBe(true)
  })
  it('detects and strips a signature block (without verifying it)', () => {
    const p = parseBundle(makeBundle({ signature: true }))
    expect(p.signed).toBe(true)
    expect(p.manifest.name).toBe('demo-ext')
  })
  it('accepts the legacy dxt_version field', () => {
    const m = manifest({ manifest_version: undefined, dxt_version: '0.1' })
    expect(parseBundle(makeBundle({ manifest: m })).manifest.name).toBe('demo-ext')
  })
  it.each([
    ['path traversal', { '../evil.txt': 'x' }],
    ['absolute path', { '/etc/evil': 'x' }],
    ['backslash path', { 'a\\..\\b': 'x' }],
    ['drive letter', { 'C:/evil': 'x' }]
  ])('rejects %s in zip entries', (_n, files) => {
    expect(() => parseBundle(makeBundle({ files }))).toThrow(BundleError)
  })
  it('rejects non-zip data, missing/invalid/unsupported manifests', () => {
    expect(() => parseBundle(strToU8('hello'))).toThrow(/not a valid \.mcpb/)
    expect(() => parseBundle(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/manifest.json is missing/)
    expect(() => parseBundle(makeBundle({ manifest: '{nope' }))).toThrow(/not valid JSON/)
    expect(() => parseBundle(makeBundle({ manifest: manifest({ manifest_version: '9.9' }) }))).toThrow(/Unsupported/)
    expect(() => parseBundle(makeBundle({ manifest: manifest({ version: undefined }) }))).toThrow(/Invalid manifest/)
  })
  it('rejects an unsupported platform and a missing entry point', () => {
    expect(() => parseBundle(makeBundle({ manifest: manifest({ compatibility: { platforms: ['win32'] } }) }), 'linux')).toThrow(/operating system/)
    const m = manifest()
    ;(m.server as { entry_point: string }).entry_point = 'nope.js'
    expect(() => parseBundle(makeBundle({ manifest: m }))).toThrow(/Entry point/)
  })
  it('enforces the unpacked size limit', () => {
    const old = LIMITS.unpackedBytes
    LIMITS.unpackedBytes = 100
    try {
      expect(() => parseBundle(makeBundle({ files: { 'big.bin': new Uint8Array(5000) } }))).toThrow(/too large/)
    } finally {
      LIMITS.unpackedBytes = old
    }
  })
})

describe('helpers', () => {
  it('safeEntryName skips junk and directories', () => {
    expect(safeEntryName('__MACOSX/x')).toBe('')
    expect(safeEntryName('a/.DS_Store')).toBe('')
    expect(safeEntryName('dir/')).toBe('')
    expect(safeEntryName('./a/b.js')).toBe('a/b.js')
  })
  it('idFromName sanitises', () => {
    expect(idFromName('@Scope/My Pkg')).toBe('scope-my-pkg')
    expect(() => idFromName('..')).toThrow()
  })
  it('normalizeUserConfig coerces and validates', () => {
    const fields = {
      n: { type: 'number' as const, title: 'n', description: '', min: 1, max: 5 },
      b: { type: 'boolean' as const, title: 'b', description: '' },
      d: { type: 'directory' as const, title: 'd', description: '' },
      l: { type: 'string' as const, title: 'l', description: '', multiple: true },
      s: { type: 'string' as const, title: 's', description: '', required: true, sensitive: true }
    }
    const ok = normalizeUserConfig(fields, { n: '3', b: 'true', d: '/x', l: 'a\n\n b', s: 'k' }, { pathExists: () => true })
    expect(ok.errors).toEqual({})
    expect(ok.values).toEqual({ n: 3, b: true, d: '/x', l: ['a', 'b'], s: 'k' })
    const bad = normalizeUserConfig(fields, { n: '9', b: 'maybe', d: '/nope' }, { pathExists: () => false })
    expect(bad.errors).toMatchObject({ n: 'Must be at most 5', b: expect.any(String), d: expect.stringContaining('/nope'), s: 'Required' })
    expect(normalizeUserConfig(fields, {}, { keepSecret: ['s'] }).errors).toEqual({})
  })
})

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
    const pv = s.preview(makeBundle())
    expect(pv).toMatchObject({ id: 'demo-ext', displayName: 'Demo Extension', serverType: 'node', signed: false })
    expect(pv.defaults).toEqual({ greeting: 'hello', folder: join(home, 'docs') })
    expect(pv.tools).toEqual([{ name: 'info', description: 'Report config' }])

    const bad = s.install(pv.stagingId, {})
    expect(bad).toMatchObject({ ok: false, fieldErrors: { api_key: 'Required' } })
    const res = s.install(pv.stagingId, { api_key: 'sk-secret' })
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, 'ext', 'demo-ext', 'server', 'index.js'))).toBe(true)

    // secrets never touch extensions.json; they are in the (encrypted) vault
    expect(readFileSync(join(dir, 'ext', 'extensions.json'), 'utf8')).not.toContain('sk-secret')
    expect(readFileSync(join(dir, 'v', 'vault.enc'), 'utf8')).not.toContain('sk-secret')
    expect(vault.get('ext:demo-ext')).toEqual({ api_key: 'sk-secret' })

    const listed = s.list()[0]!
    expect(listed).toMatchObject({ id: 'demo-ext', enabled: true, missingRequired: [], secretKeys: ['api_key'] })
    expect(JSON.stringify(listed)).not.toContain('sk-secret')

    const [cfg] = await s.servers()
    expect(cfg).toMatchObject({ id: 'ext:demo-ext', name: 'demo-ext', enabled: true, command: 'node', extensionId: 'demo-ext', cwd: join(dir, 'ext', 'demo-ext') })
    expect(cfg!.args).toEqual([join(dir, 'ext', 'demo-ext', 'server', 'index.js'), join(home, 'docs')])
    expect(cfg!.env).toEqual({ GREETING: 'hello', SECRET: 'sk-secret' })
  })

  it('runs the installed server end to end through McpHost', async () => {
    const { s } = store()
    const pv = s.preview(makeBundle())
    expect(s.install(pv.stagingId, { api_key: 'sk-1', greeting: 'hi there' }).ok).toBe(true)
    const host = new McpHost()
    await host.sync(await s.servers())
    expect(host.status()).toMatchObject([{ name: 'demo-ext', state: 'connected', tools: ['info'], extensionId: 'demo-ext' }])
    const r = await host.call('demo-ext__info', {})
    const info = JSON.parse(r.text)
    expect(info).toMatchObject({ greeting: 'hi there', secret: 'sk-1' })
    expect(info.cwd).toContain('demo-ext')
    await host.shutdown()
  }, 20000)

  it('keeps a stored secret on update when the field is left empty, and reports the previous version', () => {
    const { s } = store()
    s.install(s.preview(makeBundle()).stagingId, { api_key: 'keep-me' })
    const pv2 = s.preview(makeBundle({ manifest: manifest({ version: '2.0.0' }) }))
    expect(pv2.previous).toMatchObject({ version: '1.0.0', secretKeys: ['api_key'] })
    expect(s.install(pv2.stagingId, { api_key: '' }).ok).toBe(true)
    expect(s.list()[0]).toMatchObject({ version: '2.0.0', missingRequired: [] })
  })

  it('configure validates, disable hides the server, uninstall removes everything', async () => {
    const { s, dir, vault } = store()
    s.install(s.preview(makeBundle()).stagingId, { api_key: 'k' })
    expect(s.configure('demo-ext', { folder: '/definitely/not/here' })).toMatchObject({ ok: false, fieldErrors: { folder: expect.stringContaining('not found') } })
    expect(s.configure('demo-ext', { greeting: 'yo' }).ok).toBe(true)
    expect((await s.servers())[0]!.env.GREETING).toBe('yo')
    s.setEnabled('demo-ext', false)
    expect((await s.servers())[0]!.enabled).toBe(false)
    s.uninstall('demo-ext')
    expect(s.list()).toEqual([])
    expect(existsSync(join(dir, 'ext', 'demo-ext'))).toBe(false)
    expect(vault.get('ext:demo-ext')).toBeUndefined()
  })

  it('does not start an extension whose required setting went missing, and reports it as needing setup', async () => {
    const { s, vault } = store()
    s.install(s.preview(makeBundle()).stagingId, { api_key: 'k' })
    expect((await s.servers())[0]).toMatchObject({ enabled: true, command: 'node' })
    vault.delete('ext:demo-ext') // e.g. the keychain entry was lost
    expect(s.list()[0]).toMatchObject({ missingRequired: ['api_key'], secretKeys: [] })
    expect((await s.servers())[0]).toMatchObject({ id: 'ext:demo-ext', enabled: false, command: '' })
    expect(s.configure('demo-ext', { api_key: 'new' }).ok).toBe(true)
    expect((await s.servers())[0]).toMatchObject({ enabled: true })
  })

  it('falls back to the bundled Node runtime when no node is installed, and python3 for python', async () => {
    const { s } = store({ hasCommand: () => false })
    s.install(s.preview(makeBundle()).stagingId, { api_key: 'k' })
    const [cfg] = await s.servers()
    expect(cfg).toMatchObject({ command: process.execPath })
    expect(cfg!.env.ELECTRON_RUN_AS_NODE).toBe('1')

    const py = manifest({ name: 'py-ext', server: { type: 'python', entry_point: 'server/main.py', mcp_config: { command: 'python', args: ['${__dirname}/server/main.py'] } }, user_config: undefined })
    const s2 = store({ hasCommand: (c) => c === 'python3' }).s
    s2.install(s2.preview(makeBundle({ manifest: py, files: { 'server/main.py': 'print(1)' } })).stagingId, {})
    expect((await s2.servers())[0]!.command).toBe('python3')
  })

  it('a failed update leaves the old version in place and no staging dirs behind', () => {
    const { s, dir } = store()
    s.install(s.preview(makeBundle()).stagingId, { api_key: 'k' })
    expect(s.install('expired-id', {})).toMatchObject({ ok: false })
    expect(readdirSync(join(dir, 'ext')).filter((n) => n.startsWith('.staging'))).toEqual([])
    expect(statSync(join(dir, 'ext', 'demo-ext')).isDirectory()).toBe(true)
  })
})
