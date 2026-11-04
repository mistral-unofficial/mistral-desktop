import { describe, expect, it } from 'vitest'
import { StreamState, applyPatches, linearize, parseFrames, toWorkMessage } from '../src/main/work/protocol'
import { WorkClient, type WorkPage } from '../src/main/work/client'

// Frames copied from a real POST /api/chat answer (shortened).
const frame = (code: number, data: unknown): string => `${code}:${JSON.stringify(data)}\n`
const ev = (json: unknown): string => frame(15, { json })
const raw = (id: string, role: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({ id, role, content: '', contentChunks: null, parentId, status: 'active', generationStatus: 'success', createdAt: '2026-11-04T10:00:00Z', ...extra })

describe('patches', () => {
  it('applies replace, add, remove and append like the server stream', () => {
    const doc = { contentChunks: [{ type: 'text', text: 'Just', _context: { type: 'reasoning', contextId: 'a' } }] }
    const out = applyPatches(doc, [
      { op: 'add', path: '/contentChunks/1', value: { type: 'text', text: ' a ping.' } },
      { op: 'add', path: '/contentChunks/2', value: { type: 'text', text: 'P' } },
      { op: 'replace', path: '/contentChunks/0/_context/endTime', value: 5 },
      { op: 'remove', path: '/contentChunks/2' },
      { op: 'remove', path: '/contentChunks/1/_context' },
      { op: 'append', path: '/contentChunks/0/text', value: ' more' }
    ])
    expect(out.contentChunks.map((c) => c.text)).toEqual(['Just more', ' a ping.'])
    expect((out.contentChunks[0] as unknown as { _context: { endTime: number } })._context.endTime).toBe(5)
  })
  it('replaces the whole document for path "/"', () => {
    expect(applyPatches({ a: 1 }, [{ op: 'replace', path: '/', value: { b: 2 } }])).toEqual({ b: 2 })
  })
})

describe('frames', () => {
  it('splits complete lines and keeps the unfinished tail', () => {
    const a = ev({ type: 'chat', patches: [] })
    const { frames, rest } = parseFrames(a + frame(8, null) + '15:{"json":{"ty')
    expect(frames.map((f) => f.code)).toEqual([15, 8])
    expect(rest).toBe('15:{"json":{"ty')
  })
  it('skips malformed lines', () => {
    expect(parseFrames('garbage\n6:{"message":"x"}\n').frames).toEqual([{ code: 6, data: { message: 'x' } }])
  })
})

describe('messages', () => {
  it('separates reasoning from the answer', () => {
    const m = toWorkMessage(raw('1', 'assistant', null, { contentChunks: [{ type: 'text', text: 'thinking', _context: { type: 'reasoning' } }, { type: 'text', text: 'Pong!' }] }) as never)
    expect(m).toMatchObject({ text: 'Pong!', reasoning: 'thinking', role: 'assistant' })
  })
  it('falls back to plain content', () => {
    expect(toWorkMessage(raw('1', 'user', null, { content: 'hi' }) as never).text).toBe('hi')
  })
  it('linearizes the newest-first list into the active conversation, latest version wins', () => {
    const list = [
      raw('a2', 'assistant', 'u2', { createdAt: '2026-11-04T10:04:00Z' }),
      raw('u2', 'user', 'a1', { createdAt: '2026-11-04T10:03:00Z' }),
      raw('a1-old', 'assistant', 'u1', { status: 'inactive', createdAt: '2026-11-04T10:01:30Z' }),
      raw('a1', 'assistant', 'u1', { createdAt: '2026-11-04T10:02:00Z' }),
      raw('u1', 'user', null, { createdAt: '2026-11-04T10:01:00Z' })
    ]
    expect(linearize(list as never).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})

describe('stream state', () => {
  it('builds a chat from bootstrap, patches and the title event', () => {
    const s = new StreamState()
    const chat = { id: 'c1', title: 'Neuer Chat', generatedTitle: null, userTitle: null }
    expect(s.apply(parseFrames(ev({ type: 'bootstrap', chat, messages: [raw('u', 'user', null, { content: 'ping' })] })).frames[0]!)).toBe(true)
    const send = (json: unknown): void => void s.apply(parseFrames(ev(json)).frames[0]!)
    send({ type: 'message', messageId: 'a', messageVersion: 0, patches: [{ op: 'replace', path: '/', value: raw('a', 'assistant', 'u', { generationStatus: 'in-progress' }) }] })
    send({ type: 'chat', patches: [{ op: 'replace', path: '/generatedTitle', value: 'Greeting' }] })
    send({ type: 'message', messageId: 'a', messageVersion: 0, patches: [{ op: 'replace', path: '/contentChunks', value: [{ type: 'text', text: 'Pong' }] }, { op: 'replace', path: '/generationStatus', value: 'success' }] })
    const snap = s.snapshot('c1')
    expect(snap.title).toBe('Greeting')
    expect(snap.messages.map((m) => [m.role, m.text, m.status])).toEqual([['user', 'ping', 'success'], ['assistant', 'Pong', 'success']])
  })
  it('records server errors and the end marker', () => {
    const s = new StreamState()
    s.apply({ code: 6, data: { message: 'Not enough capacity', httpCode: 429 } })
    s.apply({ code: 8, data: null })
    expect(s.error).toBe('Not enough capacity')
    expect(s.ended).toBe(true)
  })
})

/** A fake chat.mistral.ai page: answers tRPC fetches from tables and plays a canned /api/chat stream. */
function fakePage(opts: { signedIn?: boolean; stream?: (string | ((calls: string[]) => string))[]; byId?: unknown; messages?: unknown[] } = {}) {
  const calls: string[] = []
  let polled = 0
  const trpc = (data: unknown) => ({ status: 200, body: JSON.stringify([{ result: { data: { json: data } } }]) })
  const page: WorkPage = {
    signedIn: async () => opts.signedIn ?? true,
    evaluate: async (js) => {
      calls.push(js)
      if (js.includes('/api/trpc/chat.last')) return trpc({ items: [{ id: 'c1', title: 'Neuer Chat', generatedTitle: 'Hello', userTitle: null, updatedAt: '2026-11-04T10:00:00.000Z', pinned: true }], nextCursor: null })
      if (js.includes('/api/trpc/chat.byId')) return trpc(opts.byId ?? { id: 'c1', title: 'Neuer Chat', generatedTitle: 'Hello', features: ['agentic-harness'], modelConfig: { model_alias: 'm' } })
      if (js.includes('/api/trpc/message.all')) return trpc({ items: opts.messages ?? [], nextCursor: null })
      if (js.includes('/api/trpc/chat.getNewChatConfig')) return trpc({ modelConfig: { model_alias: 'glm' }, tools: ['beta-websearch'] })
      if (js.includes('/api/trpc/chat.delete')) return trpc({ ok: true })
      if (js.includes("return 'started'")) return 'started'
      if (js.includes('window.__work &&') && js.includes('buf')) {
        const item = opts.stream?.[polled++]
        const chunk = typeof item === 'function' ? item(calls) : item
        return { chunk: chunk ?? '', done: polled >= (opts.stream?.length ?? 0), err: null }
      }
      return undefined
    }
  }
  return { page, calls }
}

describe('WorkClient', () => {
  it('lists chats with their titles', async () => {
    const { page } = fakePage()
    const r = await new WorkClient(page).list()
    expect(r.chats).toEqual([{ id: 'c1', title: 'Hello', updatedAt: Date.parse('2026-11-04T10:00:00.000Z'), pinned: true }])
  })
  it('refuses when signed out', async () => {
    await expect(new WorkClient(fakePage({ signedIn: false }).page).list()).rejects.toThrow(/Not signed in/)
  })
  it('loads a chat in order', async () => {
    const { page } = fakePage({ messages: [raw('a', 'assistant', 'u', { content: 'hey' }), raw('u', 'user', null, { content: 'hi' })] })
    const c = await new WorkClient(page).get('c1')
    expect(c.messages.map((m) => m.text)).toEqual(['hi', 'hey'])
  })
  it('creates a chat and streams snapshots, using the account defaults', async () => {
    const chat = { id: 'new', title: 'Neuer Chat', generatedTitle: null, userTitle: null }
    const { page, calls } = fakePage({
      stream: [
        ev({ type: 'bootstrap', chat, messages: [raw('u', 'user', null, { content: 'hi' })] }) + ev({ type: 'message', messageId: 'a', patches: [{ op: 'replace', path: '/', value: raw('a', 'assistant', 'u', { generationStatus: 'in-progress' }) }] }),
        ev({ type: 'message', messageId: 'a', patches: [{ op: 'replace', path: '/contentChunks', value: [{ type: 'text', text: 'Hello!' }] }, { op: 'replace', path: '/generationStatus', value: 'success' }] }) + frame(8, null)
      ]
    })
    const seen: string[] = []
    const final = await new WorkClient(page).send({ text: 'hi' }, (e) => e.type === 'state' && seen.push(e.chat.messages.map((m) => m.text).join('|')))
    expect(seen.at(-1)).toBe('hi|Hello!')
    expect(final?.id).toBe('new')
    const start = calls.find((c) => c.includes("return 'started'"))!
    expect(start).toContain('"mode":"create"')
    expect(start).toContain('"productType":"work"')
    expect(start).toContain('beta-websearch')
    expect(start).toContain('"model_alias":"glm"')
  })
  it('appends to an existing chat with its own settings', async () => {
    const chat = { id: 'c1', title: 'x', generatedTitle: 'Hello' }
    const { page, calls } = fakePage({ messages: [raw('u', 'user', null, { content: 'hi' }), raw('a', 'assistant', 'u', { content: 'yo' })], stream: [(c) => {
      const mine = /\"messageId\":\"([0-9a-f-]{36})\"/.exec(c.find((x) => x.includes("return 'started'"))!)![1]!
      return frame(15, { json: { type: 'message', messageId: 'a2', patches: [{ op: 'replace', path: '/', value: raw('a2', 'assistant', mine, { content: 'again', createdAt: '2099-01-01T00:00:00Z' }) }] } }) + frame(8, null)
    }] })
    void chat
    const final = await new WorkClient(page).send({ chatId: 'c1', text: 'more' }, () => undefined)
    // The appended turn arrives without the user's message; the assistant answer must still land after it.
    expect(final?.messages.map((m) => [m.role, m.text])).toEqual([['user', 'hi'], ['assistant', 'yo'], ['user', 'more'], ['assistant', 'again']])
    const start = calls.find((c) => c.includes("return 'started'"))!
    expect(start).toContain('"mode":"append"')
    expect(start).toContain('"chatId":"c1"')
    expect(start).toContain('"model_alias":"m"')
  })
  it('reports a server error from the stream', async () => {
    const { page } = fakePage({ stream: [frame(6, { message: 'Not enough capacity available', httpCode: 429 }) + frame(8, null)] })
    await expect(new WorkClient(page).send({ text: 'hi' }, () => undefined)).rejects.toThrow('Not enough capacity')
  })
  it('deletes a chat', async () => {
    const { page, calls } = fakePage()
    await new WorkClient(page).remove('c1')
    expect(calls.some((c) => c.includes('chat.delete') && c.includes('c1'))).toBe(true)
  })
})
