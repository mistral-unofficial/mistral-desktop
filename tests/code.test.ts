import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CodeEvent } from '../src/shared/types'
import { AcpClient } from '../src/main/code/acp-client'
import { CodeService } from '../src/main/code/service'
import { SettingsStore } from '../src/main/settings'

const AGENT = resolve('tests/fixtures/fake-agent.mjs')
const tmp = (): string => mkdtempSync(join(tmpdir(), 'md-code-'))
const noCrypto = { available: () => false, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() }

function service(mode: string, extra: Record<string, unknown> = {}) {
  process.env.FAKE_MODE = mode
  const settings = new SettingsStore(tmp(), noCrypto, {})
  settings.update({ vibePath: AGENT, ...extra })
  const events: CodeEvent[] = []
  const svc = new CodeService(settings, (_id, e) => events.push(e))
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
    const mcp = [
      { id: '1', name: 'on', command: 'node', args: ['a.js'], env: { K: 'v' }, enabled: true },
      { id: '2', name: 'off', command: 'node', args: [], env: {}, enabled: false }
    ]
    const { svc, settings } = service('normal', { mcpServers: mcp })
    // capture the agent's stderr line through the client directly
    const c = new AcpClient()
    let err = ''
    c.on('stderr', (t: string) => (err += t))
    c.start(AGENT, [], { cwd: tmp() })
    await c.initialize()
    const { toAcpServers } = await import('../src/main/mcp/host')
    await c.newSession(tmp(), toAcpServers(settings.get().mcpServers))
    await new Promise((r) => setTimeout(r, 100))
    expect(JSON.parse(err.trim().replace(/^mcp:/, ''))).toEqual([{ name: 'on', command: 'node', args: ['a.js'], env: [{ name: 'K', value: 'v' }] }])
    c.kill()
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

  it('rejects a path that is not a folder', async () => {
    const { svc } = service('normal')
    expect(await svc.start('/definitely/not/here')).toMatchObject({ status: 'error' })
  })
})
