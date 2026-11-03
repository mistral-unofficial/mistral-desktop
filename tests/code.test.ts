import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodeEvent, McpServerConfig } from '../src/shared/types'
import { CodeService } from '../src/main/code/service'
import { SettingsStore } from '../src/main/settings'

const AGENT = resolve('tests/fixtures/fake-agent.mjs')
const tmp = (): string => mkdtempSync(join(tmpdir(), 'md-code-'))
const noCrypto = { available: async () => false, encrypt: async (s: string) => Buffer.from(s), decrypt: async (b: Buffer) => b.toString() }

function service(mode: string, extra: Record<string, unknown> = {}, servers: unknown[] = []) {
  process.env.FAKE_MODE = mode
  const settings = new SettingsStore(tmp(), noCrypto, {})
  settings.update({ vibePath: AGENT, ...extra })
  const events: CodeEvent[] = []
  const svc = new CodeService(settings, (_id, e) => events.push(e), async () => servers)
  const waitFor = async (pred: (e: CodeEvent) => boolean, ms = 4000): Promise<CodeEvent> => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const f = events.find(pred)
      if (f) return f
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('timeout; saw ' + JSON.stringify(events))
  }
  return { svc, events, settings, waitFor }
}
const text = (e: CodeEvent): string => (e.type === 'update' ? JSON.stringify(e.update) : '')

describe('CodeService with a fake ACP agent', () => {
  it('starts a session, streams updates and ends the turn', async () => {
    const { svc, events, waitFor, settings } = service('normal')
    const cwd = tmp()
    const r = await svc.start(cwd)
    expect(r).toMatchObject({ status: 'ready', currentMode: 'accept-edits' })
    if (r.status !== 'ready') return
    expect(r.modes.map((m) => m.id)).toEqual(['ask', 'accept-edits'])
    expect(settings.get().recentFolders[0]).toBe(cwd)
    svc.prompt(r.id, 'hello')
    await waitFor((e) => e.type === 'turn-end')
    expect(events.some((e) => text(e).includes('echo: hello'))).toBe(true)
    await svc.setMode(r.id, 'ask')
    svc.stop(r.id)
  })

  it('passes enabled MCP servers to session/new', async () => {
    const { toAcpServers } = await import('../src/main/mcp/host')
    const configs: McpServerConfig[] = [
      { id: '1', name: 'on', command: 'node', args: ['a.js'], env: { K: 'v' }, enabled: true },
      { id: '2', name: 'off', command: 'node', args: [], env: {}, enabled: false },
      { id: '3', name: 'web', transport: 'http', url: 'https://x.example/mcp', headers: { A: 'b' }, command: '', args: [], env: {}, enabled: true }
    ]
    const { svc, events, waitFor } = service('normal', {}, await toAcpServers(configs))
    const r = await svc.start(tmp())
    expect(r.status).toBe('ready')
    const e = await waitFor((x) => /new-servers=/.test(JSON.stringify(x)))
    const sent = JSON.parse(JSON.stringify(e).match(/new-servers=(\[.*\])/)![1]!.replace(/\\"/g, '"'))
    expect(sent).toEqual([
      { name: 'on', command: 'node', args: ['a.js'], env: [{ name: 'K', value: 'v' }] },
      { type: 'http', name: 'web', url: 'https://x.example/mcp', headers: [{ name: 'A', value: 'b' }] }
    ])
    void events
    svc.stopAll()
  })

  it('permission request round trip: allow and cancel', async () => {
    const { svc, events, waitFor } = service('normal')
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    svc.prompt(r.id, 'ask')
    const p = (await waitFor((e) => e.type === 'permission')) as Extract<CodeEvent, { type: 'permission' }>
    expect(p.title).toBe('Run ls')
    expect(p.options.map((o) => o.optionId)).toEqual(['allow', 'deny'])
    svc.respondPermission(r.id, p.requestId, 'allow')
    await waitFor((e) => e.type === 'turn-end')
    expect(events.some((e) => /outcome=.*selected.*allow/.test(text(e)))).toBe(true)

    events.length = 0
    svc.prompt(r.id, 'ask')
    await waitFor((e) => e.type === 'permission')
    svc.cancel(r.id) // cancelling while a permission is open answers it as cancelled
    const end = (await waitFor((e) => e.type === 'turn-end')) as Extract<CodeEvent, { type: 'turn-end' }>
    expect(end.stopReason).toBe('cancelled')
    svc.stopAll()
  })

  it('rejects a second prompt while a turn is running', async () => {
    const { svc, events, waitFor } = service('normal')
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    svc.prompt(r.id, 'ask')
    await waitFor((e) => e.type === 'permission')
    svc.prompt(r.id, 'again')
    expect(events).toContainEqual({ type: 'error', message: 'A turn is already running' })
    svc.cancel(r.id)
    svc.stopAll()
  })

  it('needs-auth flow: session/new fails, authenticate succeeds, then ready', async () => {
    const { svc } = service('needsauth')
    const r = await svc.start(tmp())
    expect(r).toMatchObject({ status: 'needs-auth', authMethods: [{ id: 'browser-auth' }] })
    if (r.status !== 'needs-auth') return
    expect(r.message).toMatch(/Missing API key/)
    const r2 = await svc.authenticate(r.id, 'browser-auth')
    expect(r2.status).toBe('ready')
    svc.stopAll()
  })

  it('reports a missing vibe binary with an install hint', async () => {
    const { svc } = service('normal', { vibePath: '/nonexistent/vibe-acp' })
    const r = await svc.start(tmp())
    expect(r).toMatchObject({ status: 'error', message: expect.stringContaining('uv tool install mistral-vibe') })
  })

  it('lists stored sessions for the folder (newest first, current one excluded) and resumes one', async () => {
    const { svc, events, waitFor } = service('normal', {}, [{ name: 'srv', command: 'x', args: [], env: [] }])
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    expect(r.canResume).toBe(true)
    const list = await svc.listSessions(r.id)
    expect(list.map((s) => s.sessionId)).toEqual(['old-2', 'old-1']) // 's1' is the open session
    expect(list[0]).toMatchObject({ title: 'Untitled session' })

    events.length = 0
    const res = await svc.resume(r.id, 'old-1')
    if (res.status !== 'ready') throw new Error(res.status === 'error' ? res.message : '')
    expect(res.currentMode).toBe('ask')
    expect(res.history.map((u) => u.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk', 'agent_message_chunk'])
    expect(JSON.stringify(res.history)).toContain('load-servers=')
    expect(events).toEqual([]) // replayed history is returned, not streamed as live events

    svc.prompt(r.id, 'continue')
    await waitFor((e) => e.type === 'turn-end')
    expect(events.some((e) => text(e).includes('session=old-1'))).toBe(true)
    svc.stopAll()
  })

  it('reports a failed resume and refuses while a turn is running', async () => {
    const { svc, waitFor } = service('normal')
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    expect(await svc.resume(r.id, 'missing')).toEqual({ status: 'error', message: 'Session not found' })
    svc.prompt(r.id, 'ask')
    await waitFor((e) => e.type === 'permission')
    expect(await svc.resume(r.id, 'old-1')).toMatchObject({ status: 'error', message: expect.stringContaining('current turn') })
    svc.cancel(r.id)
    svc.stopAll()
  })

  it('agents without session support: canResume is false, list is empty, resume errors', async () => {
    const { svc } = service('noresume')
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    expect(r.canResume).toBe(false)
    expect(await svc.listSessions(r.id)).toEqual([])
    expect(await svc.resume(r.id, 'old-1')).toMatchObject({ status: 'error' })
    svc.stopAll()
  })

  it('lists recent folders with their stored sessions without an open session', async () => {
    const a = tmp()
    const { svc, settings } = service('normal', { recentFolders: [a, join(a, 'gone')] })
    const ws = await svc.listWorkspaces()
    expect(ws.map((w) => w.path)).toEqual([a]) // folders that no longer exist are dropped
    expect(ws[0]!.sessions.map((x) => x.sessionId)).toEqual(['s1', 'old-2', 'old-1'])
    expect(settings.get().recentFolders).toHaveLength(2)
  })

  it('delegated sign-in: the app opens the URL Vibe returns, then imports the key', async () => {
    const { svc, settings } = service('signin')
    const opened: string[] = []
    let close!: () => void
    const closed = new Promise<void>((r) => (close = r))
    const svc2 = new CodeService(settings, () => undefined, async () => [], async () => 'key-from-vibe')
    let closeCalls = 0
    const r = await svc2.signInWithBrowser({ open: (url) => (opened.push(url), { closed, close: () => (closeCalls++, close()) }) })
    expect(r).toEqual({ ok: true })
    expect(closeCalls).toBeGreaterThan(0) // the window is closed once sign-in is done
    expect(opened).toEqual(['https://auth.example/sign-in?x=1'])
    expect(await settings.getApiKey()).toBe('key-from-vibe')
    void svc
  })

  it('delegated sign-in: closing the window right after finishing still counts (grace period)', async () => {
    const { settings } = service('signin')
    const svc = new CodeService(settings, () => undefined, async () => [], async () => 'never')
    const r = await svc.signInWithBrowser({ open: () => ({ closed: Promise.resolve(), close: () => undefined }) })
    expect(r.ok).toBe(true)
    expect(await settings.getApiKey()).toBe('never')
  })

  it('delegated sign-in: a failed exchange reports the error and still closes the window', async () => {
    const { settings } = service('signinfail')
    const svc = new CodeService(settings, () => undefined, async () => [], async () => 'x')
    let closed = 0
    const r = await svc.signInWithBrowser({ open: () => ({ closed: new Promise<void>(() => undefined), close: () => void closed++ }) })
    expect(r).toEqual({ ok: false, error: 'Sign-in exchange failed' })
    expect(closed).toBe(1)
    expect(await settings.getApiKey()).toBeUndefined()
  })

  it('renames and deletes stored sessions, reporting errors as messages', async () => {
    const { svc } = service('normal')
    expect(await svc.renameSession('old-1', '  New name ')).toBeUndefined()
    expect(await svc.renameSession('old-1', '   ')).toBe('The name cannot be empty')
    expect(await svc.renameSession('missing', 'x')).toBe('Session not found')
    expect(await svc.deleteSession('old-1')).toBeUndefined()
    expect(await svc.deleteSession('missing')).toBe('Session not found')
  })

  it('deleting the open session stops its agent; renaming it goes through the open agent', async () => {
    const { svc, events } = service('normal')
    const r = await svc.start(tmp())
    if (r.status !== 'ready') throw new Error('not ready')
    expect(r.sessionId).toBe('s1')
    expect(await svc.renameSession('s1', 'Mine')).toBeUndefined()
    expect(await svc.deleteSession('s1')).toBeUndefined()
    svc.prompt(r.id, 'still there?')
    expect(events.some((e) => e.type === 'error')).toBe(true) // the session is gone
  })

  it('rejects a path that is not a folder', async () => {
    const { svc } = service('normal')
    expect(await svc.start('/definitely/not/here')).toMatchObject({ status: 'error' })
  })
})
