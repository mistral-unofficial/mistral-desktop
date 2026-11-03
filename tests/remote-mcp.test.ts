import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startMockRemote, type MockRemote } from '../e2e/mock-remote-mcp.mjs'
import { McpHost, toAcpServers, validateRemoteUrl } from '../src/main/mcp/host'
import { OAuthStore, startCallbackServer } from '../src/main/mcp/oauth'
import { SecretVault } from '../src/main/vault'
import type { McpServerConfig } from '../src/shared/types'

const remote = (o: Partial<McpServerConfig> & { url: string }): McpServerConfig => ({ id: 'r1', name: 'remote', enabled: true, transport: 'http', command: '', args: [], env: {}, ...o })
const crypto = { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() }
const newStore = (dir = mkdtempSync(join(tmpdir(), 'md-oauth-'))) => new OAuthStore(new SecretVault(dir, crypto))
/** Stands in for the user's browser: follows the authorize redirect to the app's loopback callback. */
const fakeBrowser = async (url: string): Promise<void> => void (await fetch(url, { redirect: 'follow' }))

let servers: MockRemote[] = []
let hosts: McpHost[] = []
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()))
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  hosts = []
})
const mock = async (mode: 'open' | 'bearer' | 'oauth' | 'sse') => (servers.push(await startMockRemote({ mode })), servers.at(-1)!)
const host = (d: ConstructorParameters<typeof McpHost>[0] = {}) => (hosts.push(new McpHost(d)), hosts.at(-1)!)

describe('validateRemoteUrl', () => {
  it('allows https and loopback http only, and no embedded credentials', () => {
    expect(validateRemoteUrl('https://example.com/mcp').hostname).toBe('example.com')
    expect(validateRemoteUrl('http://127.0.0.1:8000/mcp').port).toBe('8000')
    expect(validateRemoteUrl('http://localhost/mcp').hostname).toBe('localhost')
    for (const bad of ['http://example.com/mcp', 'ftp://example.com', 'javascript:alert(1)', 'not a url', '', undefined, 'https://user:pw@example.com/']) {
      expect(() => validateRemoteUrl(bad)).toThrow()
    }
  })
})

describe('remote MCP over HTTP', () => {
  it('connects to an open streamable-HTTP server, lists and calls tools', async () => {
    const s = await mock('open')
    const h = host()
    await h.sync([remote({ url: s.url })])
    expect(h.status()).toMatchObject([{ name: 'remote', kind: 'http', state: 'connected', tools: ['echo'] }])
    expect(await h.call('remote__echo', { text: 'hi' })).toEqual({ text: 'REMOTE:hi', isError: false })
  }, 20000)

  it('falls back to the legacy SSE transport', async () => {
    const s = await mock('sse')
    const h = host()
    await h.sync([remote({ url: s.url })])
    expect(h.status()[0]).toMatchObject({ state: 'connected', tools: ['echo'] })
    expect((await h.call('remote__echo', { text: 'sse' })).text).toBe('REMOTE:sse')
  }, 20000)

  it('sends custom headers; without them a 401 gives a helpful error', async () => {
    const s = await mock('bearer')
    const h = host()
    await h.sync([remote({ id: 'ok', name: 'ok', url: s.url, headers: { Authorization: 'Bearer static-token' } }), remote({ id: 'bad', name: 'bad', url: s.url })])
    const st = Object.fromEntries(h.status().map((x) => [x.name, x]))
    expect(st.ok!.state).toBe('connected')
    expect(st.bad!.state).toBe('error')
    expect(st.bad!.error).toMatch(/requires authentication/)
  }, 20000)

  it('reports unreachable servers and rejects insecure URLs without connecting', async () => {
    const h = host()
    await h.sync([remote({ id: 'a', name: 'a', url: 'http://127.0.0.1:1/mcp' }), remote({ id: 'b', name: 'b', url: 'http://evil.example.com/mcp' })])
    const st = Object.fromEntries(h.status().map((x) => [x.name, x]))
    expect(st.a!.state).toBe('error')
    expect(st.b).toMatchObject({ state: 'error', error: expect.stringContaining('https://') })
  }, 30000)
})

describe('remote MCP with OAuth', () => {
  it('needs sign-in at start (no browser opened), then authorize connects and stores tokens', async () => {
    const s = await mock('oauth')
    const store = newStore()
    let opened = 0
    const h = host({ oauth: store, openExternal: async (u) => (opened++, fakeBrowser(u)) })
    await h.sync([remote({ url: s.url, oauth: true })])
    expect(h.status()[0]).toMatchObject({ state: 'needs-auth' })
    expect(opened).toBe(0)

    expect(await h.authorize('r1')).toEqual({ ok: true })
    expect(opened).toBe(1)
    expect(h.status()[0]).toMatchObject({ state: 'connected', tools: ['echo'] })
    expect((await h.call('remote__echo', { text: 'x' })).text).toBe('REMOTE:x')
    expect(s.stats).toMatchObject({ registrations: 1, authorizes: 1, tokens: 1 })
    expect(h.accessToken('r1')).toMatch(/^tok-/)
  }, 30000)

  it('a new host reconnects silently from stored tokens, and refreshes expired ones', async () => {
    const s = await mock('oauth')
    const store = newStore()
    const first = host({ oauth: store, openExternal: fakeBrowser })
    await first.sync([remote({ url: s.url, oauth: true })])
    await first.authorize('r1')
    await first.shutdown()

    let opened = 0
    const second = host({ oauth: store, openExternal: async () => void opened++ })
    await second.sync([remote({ url: s.url, oauth: true })])
    expect(second.status()[0]!.state).toBe('connected')
    await second.shutdown()

    s.expireTokens() // access token no longer valid; refresh token still is
    const third = host({ oauth: store, openExternal: async () => void opened++ })
    await third.sync([remote({ url: s.url, oauth: true })])
    expect(third.status()[0]!.state).toBe('connected')
    expect(s.stats.refreshes).toBe(1)
    expect(s.stats.authorizes).toBe(1)
    expect(opened).toBe(0)
  }, 40000)

  it('sign out forgets credentials and returns to needs-auth', async () => {
    const s = await mock('oauth')
    const store = newStore()
    const h = host({ oauth: store, openExternal: fakeBrowser })
    await h.sync([remote({ url: s.url, oauth: true })])
    await h.authorize('r1')
    await h.signOut('r1')
    expect(h.status()[0]!.state).toBe('needs-auth')
    expect(store.get('r1').tokens).toBeUndefined()
  }, 30000)

  it('authorize reports a cancelled sign-in', async () => {
    const s = await mock('oauth')
    const h = host({
      oauth: newStore(),
      openExternal: async (u) => {
        const redirect = new URL(u).searchParams.get('redirect_uri')!
        await fetch(`${redirect}?error=access_denied&error_description=nope`)
      }
    })
    await h.sync([remote({ url: s.url, oauth: true })])
    expect(await h.authorize('r1')).toMatchObject({ ok: false, error: expect.stringContaining('access_denied') })
  }, 30000)

  it('rejects authorize on servers that do not use OAuth', async () => {
    const s = await mock('open')
    const h = host({ oauth: newStore() })
    await h.sync([remote({ url: s.url })])
    expect(await h.authorize('r1')).toMatchObject({ ok: false })
  }, 20000)
})

describe('McpHost concurrency', () => {
  it('serialises overlapping syncs and ignores a second authorize while one is running', async () => {
    const s = await mock('oauth')
    const a = remote({ id: 'a', name: 'a', url: 'http://127.0.0.1:1/mcp' })
    const b = remote({ id: 'b', name: 'b', url: s.url, oauth: true })
    const h = host({ oauth: newStore(), openExternal: async () => new Promise(() => undefined) /* never completes */ })
    await Promise.all([h.sync([a]), h.sync([b]), h.sync([a, b])])
    expect(h.status().map((x) => x.name).sort()).toEqual(['a', 'b'])
    const first = h.authorize('b')
    await new Promise((r) => setTimeout(r, 300))
    expect(await h.authorize('b')).toEqual({ ok: false, error: 'Sign-in is already in progress' })
    void first // left pending on purpose; shutdown in afterEach closes the callback server's process
  }, 30000)
})

describe('OAuth callback server', () => {
  it('ignores callbacks with the wrong state, accepts the right one, and only binds loopback', async () => {
    const cb = await startCallbackServer()
    expect(cb.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    cb.setExpectedState('good')
    const wait = cb.waitForCode(5000)
    expect((await fetch(`${cb.redirectUrl}?code=evil&state=bad`)).status).toBe(400)
    expect((await fetch(`${cb.redirectUrl}?code=nostate`)).status).toBe(400)
    expect((await fetch(`${cb.redirectUrl.replace('/callback', '/other')}`)).status).toBe(404)
    expect((await fetch(`${cb.redirectUrl}?code=abc&state=good`)).status).toBe(200)
    expect(await wait).toBe('abc')
    cb.close()
  })
  it('times out and can deliver a result that arrives before waiting starts', async () => {
    const a = await startCallbackServer()
    await expect(a.waitForCode(30)).rejects.toThrow(/Timed out/)
    a.close()
    const b = await startCallbackServer()
    b.setExpectedState('s')
    await fetch(`${b.redirectUrl}?code=early&state=s`)
    expect(await b.waitForCode(1000)).toBe('early')
    b.close()
  })
})

describe('toAcpServers', () => {
  const stdio: McpServerConfig = { id: 's', name: 'local', enabled: true, command: 'node', args: ['a'], env: { K: 'v' } }
  it('keeps the stdio shape, converts http servers and headers, and skips unsafe or unauthenticated ones', () => {
    const out = toAcpServers(
      [
        stdio,
        { ...stdio, id: 'off', enabled: false },
        remote({ id: 'h', name: 'h', url: 'https://x.example/mcp', headers: { 'X-Key': '1' } }),
        remote({ id: 'o', name: 'o', url: 'https://o.example/mcp', oauth: true }),
        remote({ id: 'o2', name: 'o2', url: 'https://o2.example/mcp', oauth: true }),
        remote({ id: 'bad', name: 'bad', url: 'http://plain.example/mcp' })
      ],
      (id) => (id === 'o' ? 'T0KEN' : undefined)
    )
    expect(out).toEqual([
      { name: 'local', command: 'node', args: ['a'], env: [{ name: 'K', value: 'v' }] },
      { type: 'http', name: 'h', url: 'https://x.example/mcp', headers: [{ name: 'X-Key', value: '1' }] },
      { type: 'http', name: 'o', url: 'https://o.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer T0KEN' }] }
    ])
  })
})
