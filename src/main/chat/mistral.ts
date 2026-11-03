import type { ToolCall, WireMessage } from '../../shared/types'

export interface ToolDef {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type StreamPart =
  | { type: 'text'; text: string }
  | { type: 'done'; toolCalls: ToolCall[]; finishReason: string | null; usage?: Usage }

export interface StreamOpts {
  apiBase: string
  apiKey: string
  model: string
  messages: WireMessage[]
  tools?: ToolDef[]
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export class MistralError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** Mistral may return content as a string or as a list of typed chunks (thinking models). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
      .join('')
  }
  return ''
}

export async function* streamChat(o: StreamOpts): AsyncGenerator<StreamPart> {
  const f = o.fetchImpl ?? fetch
  const body: Record<string, unknown> = { model: o.model, messages: o.messages, stream: true }
  if (o.tools?.length) {
    body.tools = o.tools
    body.tool_choice = 'auto'
  }
  let res: Response
  try {
    res = await f(`${o.apiBase.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify(body),
      signal: o.signal
    })
  } catch (e) {
    if (o.signal?.aborted) throw e
    throw new MistralError(`Network error: ${(e as Error).message}`)
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    let msg = text.slice(0, 500)
    try {
      const j = JSON.parse(text) as { message?: unknown; detail?: unknown; error?: { message?: string } }
      msg = String(j.message ?? j.error?.message ?? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)))
    } catch {
      /* keep raw text */
    }
    const hint = res.status === 401 ? ' (check your API key in Settings)' : ''
    throw new MistralError(`Mistral API ${res.status}: ${msg}${hint}`, res.status)
  }

  const acc = new Map<number, ToolCall>()
  let finish: string | null = null
  let usage: Usage | undefined
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''

  const handle = function* (data: string): Generator<StreamPart> {
    if (data === '[DONE]') return
    let j: { choices?: { delta?: { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: Usage }
    try {
      j = JSON.parse(data)
    } catch {
      return
    }
    if (j.usage) usage = j.usage
    const ch = j.choices?.[0]
    if (!ch) return
    const t = contentText(ch.delta?.content)
    if (t) yield { type: 'text', text: t }
    for (const tc of ch.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const cur = acc.get(idx) ?? { id: '', name: '', arguments: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.arguments += tc.function.arguments
      acc.set(idx, cur)
    }
    if (ch.finish_reason) finish = ch.finish_reason
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.startsWith('data:')) yield* handle(line.slice(5).trim())
    }
  }
  if (buf.startsWith('data:')) yield* handle(buf.slice(5).trim())

  const toolCalls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({ ...v, id: v.id || `call_${i}` }))
  yield { type: 'done', toolCalls, finishReason: finish, usage }
}

export async function listModels(apiBase: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } })
  if (!res.ok) throw new MistralError(`Mistral API ${res.status} while listing models`, res.status)
  const j = (await res.json()) as { data?: { id: string; capabilities?: { completion_chat?: boolean } }[] }
  return (j.data ?? []).filter((m) => m.capabilities?.completion_chat !== false).map((m) => m.id).sort()
}
