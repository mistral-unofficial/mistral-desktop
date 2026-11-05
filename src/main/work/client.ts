import { randomUUID } from 'node:crypto'
import type { WorkAnswer, WorkChat, WorkChatSummary, WorkEvent } from '../../shared/types'
import { StreamState, linearize, parseFrames, toSummary, toWorkMessage, type RawMessage } from './protocol'

/**
 * Client for the internal chat.mistral.ai "Work" API (tRPC + POST /api/chat). It is undocumented and may change
 * without notice. Requests are made from inside a signed-in page of the app's web session, so the login cookie
 * never leaves that session.
 */
export interface WorkPage {
  signedIn(): Promise<boolean>
  /** Runs a JavaScript expression in the signed-in page of chat.mistral.ai and returns its (JSON-able) result. */
  evaluate(js: string): Promise<unknown>
}

const TRPC_HEADERS = { 'x-trpc-source': 'nextjs-react' }
/** Only the pauses this app can show; advertising more would let the agent stall on a prompt nobody can answer. */
const CALLBACKS = ['ask_user_question']

export class WorkError extends Error {}

const lit = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029')

interface NewChatConfig {
  modelConfig?: Record<string, unknown>
  tools?: string[]
}

export class WorkClient {
  constructor(private page: WorkPage) {}

  private async need(): Promise<void> {
    if (!(await this.page.signedIn())) throw new WorkError('Not signed in to Le Chat. Sign in from Settings → Account.')
  }

  private async trpc(proc: string, input: unknown, kind: 'query' | 'mutation', dateKeys: string[] = []): Promise<unknown> {
    if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(proc)) throw new WorkError('Bad procedure')
    await this.need()
    const meta = dateKeys.length ? { values: Object.fromEntries(dateKeys.map((k) => [k, ['Date']])), v: 1 } : undefined
    const payload = { 0: { json: input, ...(meta ? { meta } : {}) } }
    const js =
      kind === 'query'
        ? `fetch('/api/trpc/${proc}?batch=1&input=' + encodeURIComponent(${lit(JSON.stringify(payload))}), { credentials: 'include', headers: ${lit(TRPC_HEADERS)} }).then(async r => ({ status: r.status, body: await r.text() }))`
        : `fetch('/api/trpc/${proc}?batch=1', { method: 'POST', credentials: 'include', headers: ${lit({ ...TRPC_HEADERS, 'content-type': 'application/json' })}, body: ${lit(JSON.stringify(payload))} }).then(async r => ({ status: r.status, body: await r.text() }))`
    const res = (await this.page.evaluate(js)) as { status: number; body: string } | undefined
    if (!res) throw new WorkError('Could not reach chat.mistral.ai')
    let parsed: { result?: { data?: { json?: unknown } }; error?: { json?: { message?: string } } }[]
    try {
      parsed = JSON.parse(res.body)
    } catch {
      throw new WorkError(`Unexpected response (HTTP ${res.status})`)
    }
    const first = parsed[0]
    if (first?.error) throw new WorkError(String(first.error.json?.message ?? 'Request failed').slice(0, 300))
    return first?.result?.data?.json
  }

  async list(cursor?: string): Promise<{ chats: WorkChatSummary[]; nextCursor?: string }> {
    const input = cursor ? { cursor } : {}
    const r = (await this.trpc('chat.last', input, 'query', cursor ? ['cursor'] : [])) as { items?: Parameters<typeof toSummary>[0][]; nextCursor?: string | null } | undefined
    return { chats: (r?.items ?? []).map(toSummary), nextCursor: r?.nextCursor ?? undefined }
  }

  private async rawMessages(chatId: string): Promise<RawMessage[]> {
    const all: RawMessage[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i++) {
      const r = (await this.trpc('message.all', cursor ? { chatId, cursor } : { chatId }, 'query', cursor ? ['cursor'] : [])) as { items?: RawMessage[]; nextCursor?: string | null } | undefined
      all.push(...(r?.items ?? []))
      cursor = r?.nextCursor ?? undefined
      if (!cursor) break
    }
    return all
  }

  async get(id: string): Promise<WorkChat> {
    const [meta, raw] = await Promise.all([this.trpc('chat.byId', { id }, 'query') as Promise<Parameters<typeof toSummary>[0]>, this.rawMessages(id)])
    return { id, title: toSummary(meta).title, messages: linearize(raw).map(toWorkMessage) }
  }

  async remove(id: string): Promise<void> {
    await this.trpc('chat.delete', { id }, 'mutation')
  }

  private async newChatConfig(): Promise<NewChatConfig> {
    try {
      return ((await this.trpc('chat.getNewChatConfig', { productType: 'work' }, 'query')) as NewChatConfig) ?? {}
    } catch {
      return {}
    }
  }

  private common(): Record<string, unknown> {
    return { clientPromptData: { currentDate: new Date().toISOString().slice(0, 10), userTimezone: tzLabel() }, transcriptionsMetadata: [], reviewComments: [], disabledFeatures: [], stableAnonymousIdentifier: randomUUID().slice(0, 7), supportedTaskCallbacks: CALLBACKS }
  }

  /**
   * Sends a message (creating the chat when `chatId` is missing) and reports the chat's growing state until the
   * server finishes. Resolves with the final chat; failures are reported through `emit` and rejected.
   */
  async send(req: { chatId?: string; text: string }, emit: (e: WorkEvent) => void, signal?: AbortSignal): Promise<WorkChat | undefined> {
    await this.need()
    const text = req.text.trim()
    if (!text) throw new WorkError('Empty message')
    const state = new StreamState()
    const common = this.common()
    let body: Record<string, unknown>
    if (req.chatId) {
      const [meta, raw] = await Promise.all([this.trpc('chat.byId', { id: req.chatId }, 'query') as Promise<{ id: string; features?: string[]; integrations?: unknown[]; libraries?: unknown[]; modelConfig?: unknown } & Parameters<typeof toSummary>[0]>, this.rawMessages(req.chatId)])
      const linear = linearize(raw)
      // The append stream never repeats the user's message, so it is added here to keep the conversation tree whole.
      const messageId = randomUUID()
      const mine: RawMessage = { id: messageId, role: 'user', content: text, contentChunks: null, parentId: linear.at(-1)?.id ?? null, status: 'active', generationStatus: 'success', createdAt: new Date().toISOString() }
      state.seed(meta, [...linear, mine])
      body = { chatId: req.chatId, mode: 'append', messageInput: [{ type: 'text', text }], messageFiles: [], messageId, features: meta.features ?? [], libraries: meta.libraries ?? [], integrations: meta.integrations ?? [], modelConfig: meta.modelConfig, preventFeaturesAndIntegrationsPersistence: false, ...common }
    } else {
      const cfg = await this.newChatConfig()
      body = { content: [{ type: 'text', text }], incognito: false, files: [], features: [...new Set([...(cfg.tools ?? []), 'agentic-harness'])], integrations: [], libraries: [], modelConfig: cfg.modelConfig ?? { model_alias: 'glm-5-latest-short', reasoning_effort: 'low' }, mode: 'create', productType: 'work', ...common }
    }
    return this.stream('/api/chat', body, state, req.chatId ?? '', emit, signal)
  }

  /** Answers a pending question of the agent; the server then continues the same assistant message. */
  async answer(req: { chatId: string } & WorkAnswer, emit: (e: WorkEvent) => void, signal?: AbortSignal): Promise<WorkChat | undefined> {
    await this.need()
    if (!req.values.length || req.values.some((v) => !v.trim())) throw new WorkError('Empty answer')
    const [meta, raw] = await Promise.all([this.trpc('chat.byId', { id: req.chatId }, 'query') as Promise<{ id: string; modelConfig?: unknown } & Parameters<typeof toSummary>[0]>, this.rawMessages(req.chatId)])
    const state = new StreamState()
    state.seed(meta, linearize(raw))
    const { clientPromptData: _c, transcriptionsMetadata: _t, reviewComments: _r, disabledFeatures: _d, stableAnonymousIdentifier: _s, ...resume } = this.common()
    const body = { chatId: req.chatId, messageId: req.messageId, ...resume, modelConfig: meta.modelConfig, callbackResults: [{ callbackId: req.callbackId, callbackName: 'ask_user_question', result: req.values.map((v) => v.trim()) }] }
    return this.stream('/api/chat/resume', body, state, req.chatId, emit, signal)
  }

  private async stream(url: string, body: Record<string, unknown>, state: StreamState, chatIdIn: string, emit: (e: WorkEvent) => void, signal?: AbortSignal): Promise<WorkChat | undefined> {
    const sid = randomUUID()
    const start = `(() => { window.__work = window.__work || {}; const s = window.__work[${lit(sid)}] = { buf: '', done: false, err: null, ac: new AbortController() };
      (async () => { try { const res = await fetch(${lit(url)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(${lit(body)}), signal: s.ac.signal });
        if (!res.ok) { s.err = 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300); return }
        const rd = res.body.getReader(), dec = new TextDecoder();
        for (;;) { const { done, value } = await rd.read(); if (done) break; s.buf += dec.decode(value, { stream: true }) }
      } catch (e) { if (!s.ac.signal.aborted) s.err = String(e) } finally { s.done = true } })(); return 'started' })()`
    await this.page.evaluate(start)
    const abort = (): void => void this.page.evaluate(`(() => { const s = window.__work && window.__work[${lit(sid)}]; if (s) s.ac.abort() })()`)
    signal?.addEventListener('abort', abort, { once: true })
    let rest = ''
    let chatId = chatIdIn
    try {
      for (;;) {
        const r = (await this.page.evaluate(`(() => { const s = window.__work && window.__work[${lit(sid)}]; if (!s) return { chunk: '', done: true, err: 'lost' }; const o = { chunk: s.buf, done: s.done, err: s.err }; s.buf = ''; if (s.done) delete window.__work[${lit(sid)}]; return o })()`)) as { chunk: string; done: boolean; err: string | null } | undefined
        if (!r) throw new WorkError('Lost the connection to chat.mistral.ai')
        if (r.chunk) {
          const parsed = parseFrames(rest + r.chunk)
          rest = parsed.rest
          let changed = false
          for (const f of parsed.frames) changed = state.apply(f) || changed
          if (state.meta?.id) chatId = state.meta.id
          if (changed) emit({ type: 'state', chat: state.snapshot(chatId) })
        }
        if (state.error) throw new WorkError(state.error)
        if (r.done) {
          if (r.err && !signal?.aborted) throw new WorkError(r.err)
          break
        }
        await new Promise((res) => setTimeout(res, 120))
      }
      return chatId ? state.snapshot(chatId) : undefined
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
}

function tzLabel(): string {
  const off = -new Date().getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  const hh = String(Math.floor(a / 60)).padStart(2, '0')
  const mm = String(a % 60).padStart(2, '0')
  return `T${sign}${hh}:${mm} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
}
