import { describe, expect, it } from 'vitest'
import { MistralError, streamChat, type StreamPart } from '../src/main/chat/mistral'
import { chunk, data, sseResponse } from './helpers'

const base = { apiBase: 'https://x/v1', apiKey: 'k', model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }
async function collect(g: AsyncGenerator<StreamPart>): Promise<StreamPart[]> {
  const out: StreamPart[] = []
  for await (const p of g) out.push(p)
  return out
}

describe('streamChat', () => {
  it('assembles text split across network chunks and mid-line', async () => {
    const full = chunk({ content: 'Hel' }) + chunk({ content: 'lo' }) + chunk({}, 'stop', { usage: { total_tokens: 3 } }) + 'data: [DONE]\n\n'
    const cut = Math.floor(full.length / 3)
    const parts = await collect(streamChat({ ...base, fetchImpl: async () => sseResponse([full.slice(0, cut), full.slice(cut, cut * 2 + 5), full.slice(cut * 2 + 5)]) }))
    expect(parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).toBe('Hello')
    const done = parts.at(-1)
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop', toolCalls: [], usage: { total_tokens: 3 } })
  })

  it('accumulates tool call arguments streamed in fragments, in index order', async () => {
    const body =
      chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }) +
      chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }) +
      chunk({}, 'tool_calls')
    const parts = await collect(streamChat({ ...base, fetchImpl: async () => sseResponse([body]) }))
    expect(parts.at(-1)).toMatchObject({ toolCalls: [{ id: 'a', name: 'one', arguments: '{"x":1}' }, { id: 'b', name: 'two', arguments: '{}' }] })
  })

  it('handles content given as a list of typed chunks and ignores thinking chunks', async () => {
    const body = chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }, { type: 'text', text: 'answer' }] }) + chunk({}, 'stop')
    const parts = await collect(streamChat({ ...base, fetchImpl: async () => sseResponse([body]) }))
    expect(parts[0]).toEqual({ type: 'text', text: 'answer' })
  })

  it('sends tools only when provided and uses the bearer key', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    await collect(streamChat({ ...base, fetchImpl: async (url, init) => ((seen = { url: String(url), init: init! }), sseResponse([chunk({}, 'stop')])) }))
    expect(seen?.url).toBe('https://x/v1/chat/completions')
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(JSON.parse(seen!.init.body as string).tools).toBeUndefined()
  })

  it('turns an HTTP 401 into a helpful error', async () => {
    const f = async (): Promise<Response> => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })
    await expect(collect(streamChat({ ...base, fetchImpl: f }))).rejects.toThrow(/401: Unauthorized.*API key/)
    await expect(collect(streamChat({ ...base, fetchImpl: f }))).rejects.toBeInstanceOf(MistralError)
  })

  it('ignores malformed SSE lines', async () => {
    const parts = await collect(streamChat({ ...base, fetchImpl: async () => sseResponse(['data: {oops\n\n', data({ choices: [{ delta: { content: 'ok' } }] })]) }))
    expect(parts[0]).toEqual({ type: 'text', text: 'ok' })
  })
})
