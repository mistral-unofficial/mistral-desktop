import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '../src/shared/types'
import { runChat } from '../src/main/chat/run'
import type { ToolProvider } from '../src/main/mcp/host'
import { chunk, sseResponse } from './helpers'

const toolCallTurn = (id: string, name: string, args: string): Response =>
  sseResponse([chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }), chunk({}, 'tool_calls')])
const textTurn = (t: string): Response => sseResponse([chunk({ content: t }), chunk({}, 'stop')])

function setup(turns: Response[], approve: (id: string) => boolean = () => true, ac = new AbortController()) {
  const events: ChatEvent[] = []
  const calls: { name: string; args: unknown }[] = []
  const bodies: { messages: { role: string }[] }[] = []
  const tools: ToolProvider = {
    tools: () => [{ type: 'function', function: { name: 'srv__echo', parameters: { type: 'object' } } }],
    describe: (n) => (n === 'srv__echo' ? { server: 'srv', tool: 'echo' } : undefined),
    call: async (name, args) => (calls.push({ name, args }), { text: 'ECHO', isError: false })
  }
  let i = 0
  const deps = {
    apiBase: 'https://x/v1', apiKey: 'k', model: 'm', tools, signal: ac.signal,
    emit: (e: ChatEvent) => events.push(e),
    approve: async (c: { id: string }) => approve(c.id),
    fetchImpl: (async (_u: unknown, init: RequestInit) => (bodies.push(JSON.parse(init.body as string)), turns[i++]!)) as unknown as typeof fetch
  }
  return { events, calls, bodies, deps, ac }
}
const wireOf = (events: ChatEvent[]) => (events.find((e) => e.type === 'wire') as Extract<ChatEvent, { type: 'wire' }>).messages

describe('runChat', () => {
  it('plain answer', async () => {
    const t = setup([textTurn('hello')])
    await runChat([{ role: 'user', content: 'hi' }], t.deps)
    expect(t.events.map((e) => e.type)).toEqual(['delta', 'wire', 'done'])
    expect(wireOf(t.events)).toEqual([{ role: 'assistant', content: 'hello' }])
    expect(t.bodies[0]!.messages[0]!.role).toBe('system')
  })

  it('runs an approved tool and feeds the result back', async () => {
    const t = setup([toolCallTurn('c1', 'srv__echo', '{"text":"x"}'), textTurn('done')])
    await runChat([{ role: 'user', content: 'go' }], t.deps)
    expect(t.calls).toEqual([{ name: 'srv__echo', args: { text: 'x' } }])
    expect(t.events.map((e) => e.type)).toEqual(['tool_pending', 'tool_running', 'tool_result', 'delta', 'wire', 'done'])
    const w = wireOf(t.events)
    expect(w.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(w[1]).toMatchObject({ tool_call_id: 'c1', content: 'ECHO' })
    expect(t.bodies[1]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  })

  it('does not run a denied tool and tells the model', async () => {
    const t = setup([toolCallTurn('c1', 'srv__echo', '{}'), textTurn('ok')], () => false)
    await runChat([{ role: 'user', content: 'go' }], t.deps)
    expect(t.calls).toEqual([])
    expect(t.events).toContainEqual({ type: 'tool_result', id: 'c1', text: 'The user denied this tool call.', isError: true, denied: true })
  })

  it('reports invalid JSON arguments as a tool error without calling the tool', async () => {
    const t = setup([toolCallTurn('c1', 'srv__echo', '{not json'), textTurn('ok')])
    await runChat([{ role: 'user', content: 'go' }], t.deps)
    expect(t.calls).toEqual([])
    expect(wireOf(t.events)[1]).toMatchObject({ role: 'tool', content: 'Invalid JSON arguments' })
  })

  it('stops after maxSteps and reports it', async () => {
    const t = setup([toolCallTurn('a', 'srv__echo', '{}'), toolCallTurn('b', 'srv__echo', '{}')])
    await runChat([{ role: 'user', content: 'go' }], { ...t.deps, maxSteps: 2 })
    expect(t.events).toContainEqual({ type: 'error', message: 'Stopped after 2 tool steps.' })
    expect(t.events.at(-1)).toEqual({ type: 'done' })
  })

  it('on abort keeps history valid (every tool call answered)', async () => {
    const t = setup([toolCallTurn('c1', 'srv__echo', '{}')], () => true)
    t.deps.approve = async () => (t.ac.abort(), false)
    await runChat([{ role: 'user', content: 'go' }], t.deps)
    const w = wireOf(t.events)
    const ids = w.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
    const answered = w.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    expect(answered.sort()).toEqual(ids.sort())
    expect(t.events.at(-1)).toEqual({ type: 'done' })
  })

  it('surfaces API errors', async () => {
    const t = setup([new Response('{"message":"boom"}', { status: 500 })])
    await runChat([{ role: 'user', content: 'x' }], t.deps)
    expect(t.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('500: boom') })
  })
})
