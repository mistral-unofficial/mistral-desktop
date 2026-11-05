import type { WorkCallback, WorkChat, WorkChatSummary, WorkMessage, WorkQuestion } from '../../shared/types'

/**
 * Pure helpers for the internal chat.mistral.ai Work API: the line framing of POST /api/chat, the JSON-patch
 * dialect it streams, and turning the stored message tree into a linear conversation.
 */

type Json = unknown
export interface Patch {
  op: 'replace' | 'add' | 'remove' | 'append'
  path: string
  value?: Json
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

/** Applies one patch in place (returns the possibly new root). Paths are JSON pointers; "/" is the whole document. */
export function applyPatch(doc: Json, p: Patch): Json {
  if (p.path === '/' || p.path === '') return p.value
  const keys = p.path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
  let cur = doc
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur)) return doc
    cur = (cur as Record<string, unknown>)[k]
  }
  const last = keys[keys.length - 1]
  if (last === undefined) return doc
  if (!isObj(cur)) return doc
  if (Array.isArray(cur)) {
    const i = last === '-' ? cur.length : Number(last)
    if (!Number.isInteger(i) || i < 0) return doc
    if (p.op === 'add') cur.splice(i, 0, p.value)
    else if (p.op === 'remove') cur.splice(i, 1)
    else if (p.op === 'append') cur[i] = String(cur[i] ?? '') + String(p.value ?? '')
    else cur[i] = p.value
    return doc
  }
  const o = cur as Record<string, unknown>
  if (p.op === 'remove') delete o[last]
  else if (p.op === 'append') o[last] = String(o[last] ?? '') + String(p.value ?? '')
  else o[last] = p.value
  return doc
}

export function applyPatches<T>(doc: T, patches: Patch[]): T {
  let d: Json = doc
  for (const p of patches) d = applyPatch(d, p)
  return d as T
}

export interface Frame {
  code: number
  data: unknown
}

/** Splits a streamed text buffer into complete `<code>:<json>` lines; the unfinished tail is returned as `rest`. */
export function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const frames: Frame[] = []
  for (const line of lines) {
    const m = /^(\d+):(.*)$/.exec(line)
    if (!m) continue
    try {
      frames.push({ code: Number(m[1]), data: JSON.parse(m[2] ?? 'null') })
    } catch {
      /* skip a malformed line */
    }
  }
  return { frames, rest }
}

/** A raw message as the server stores and streams it (only the fields this app reads). */
export interface RawMessage {
  id: string
  role: string
  content?: string | null
  contentChunks?: { type?: string; text?: string; _context?: { type?: string }; callbackId?: string; callbackName?: string; input?: unknown; result?: { status?: string; value?: unknown } }[] | null
  generationStatus?: string
  parentId?: string | null
  status?: string
  turn?: number
  createdAt?: string | number
}

export function toWorkMessage(m: RawMessage): WorkMessage {
  let text = ''
  let reasoning = ''
  const callbacks: WorkCallback[] = []
  if (Array.isArray(m.contentChunks) && m.contentChunks.length) {
    for (const c of m.contentChunks) {
      if (c?.type === 'task_callback' && typeof c.callbackId === 'string') {
        callbacks.push(toCallback(c))
        continue
      }
      if (c?.type !== 'text' || typeof c.text !== 'string') continue
      if (c._context?.type === 'reasoning') reasoning += c.text
      else text += c.text
    }
  } else text = m.content ?? ''
  return { id: m.id, role: m.role === 'user' ? 'user' : 'assistant', text, reasoning, status: m.generationStatus ?? 'success', ...(callbacks.length ? { callbacks } : {}) }
}

type RawChunk = NonNullable<RawMessage['contentChunks']>[number]
function toCallback(c: RawChunk): WorkCallback {
  const name = c.callbackName ?? ''
  const raw = (c.input as { questions?: { question?: unknown; options?: unknown }[] } | undefined)?.questions
  const questions: WorkQuestion[] =
    name === 'ask_user_question' && Array.isArray(raw)
      ? raw.filter((q) => typeof q?.question === 'string').map((q) => ({ question: String(q.question), options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : [] }))
      : []
  const v = c.result?.value
  return { id: c.callbackId ?? '', name, status: c.result?.status ?? 'pending', questions, ...(Array.isArray(v) ? { answers: v.map(String) } : {}) }
}

/**
 * Message.all returns every version of every message, newest first. Keep the active ones and follow the tree
 * from the root, preferring the latest child at each step.
 */
export function linearize(items: RawMessage[]): RawMessage[] {
  const active = items.filter((m) => (m.status ?? 'active') === 'active')
  const children = new Map<string | null, RawMessage[]>()
  for (const m of active) {
    const k = m.parentId ?? null
    children.set(k, [...(children.get(k) ?? []), m])
  }
  const when = (m: RawMessage): number => new Date(m.createdAt ?? 0).getTime()
  const out: RawMessage[] = []
  let cur = pickLatest(children.get(null), when)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.push(cur)
    cur = pickLatest(children.get(cur.id), when)
  }
  return out
}
function pickLatest(list: RawMessage[] | undefined, when: (m: RawMessage) => number): RawMessage | undefined {
  return list?.slice().sort((a, b) => when(b) - when(a))[0]
}

interface RawChatMeta {
  id: string
  title?: string
  generatedTitle?: string | null
  userTitle?: string | null
  updatedAt?: string | number
  pinned?: boolean
}

export function chatTitle(c: Pick<RawChatMeta, 'title' | 'generatedTitle' | 'userTitle'>): string {
  return c.userTitle || c.generatedTitle || c.title || 'New chat'
}
export function toSummary(c: RawChatMeta): WorkChatSummary {
  return { id: c.id, title: chatTitle(c), updatedAt: new Date(c.updatedAt ?? 0).getTime(), pinned: !!c.pinned }
}

/** State of one streamed turn, built up frame by frame. */
export class StreamState {
  meta?: RawChatMeta
  private messages = new Map<string, RawMessage>()
  private order: string[] = []
  error?: string
  ended = false

  /** Seeds the state with the messages already in the chat (for appended turns). */
  seed(meta: RawChatMeta | undefined, msgs: RawMessage[]): void {
    this.meta = meta
    for (const m of msgs) this.put(m)
  }
  private put(m: RawMessage): void {
    if (!this.messages.has(m.id)) this.order.push(m.id)
    this.messages.set(m.id, m)
  }

  /** Applies one frame; returns true when something visible changed. */
  apply(f: Frame): boolean {
    if (f.code === 8) return ((this.ended = true), true)
    if (f.code === 6) {
      const d = f.data as { message?: string; category?: string } | undefined
      this.error = d?.message ?? 'The server reported an error'
      return true
    }
    if (f.code !== 15 || !isObj(f.data)) return false
    const ev = (f.data as { json?: Record<string, unknown> }).json
    if (!ev) return false
    if (ev.type === 'bootstrap') {
      this.meta = ev.chat as RawChatMeta
      for (const m of (ev.messages as RawMessage[] | undefined) ?? []) this.put(m)
      return true
    }
    if (ev.type === 'chat' && this.meta) {
      this.meta = applyPatches(this.meta, ev.patches as Patch[])
      return true
    }
    if (ev.type === 'message') {
      const id = String(ev.messageId)
      const patches = (ev.patches as Patch[] | undefined) ?? []
      const cur = this.messages.get(id)
      const first = patches[0]
      // A patch for a message we never saw (and that is not a whole new message) cannot be applied.
      if (!cur && !(patches.length === 1 && first && (first.path === '/' || first.path === ''))) return false
      const next = patches.length === 1 && first && (first.path === '/' || first.path === '') ? (first.value as RawMessage) : applyPatches(cur ?? ({ id } as RawMessage), patches)
      if (next && isObj(next)) this.put({ ...next, id })
      return true
    }
    return false
  }

  snapshot(chatId: string): WorkChat {
    const ordered = linearize([...this.messages.values()].map((m) => ({ ...m, status: m.status ?? 'active', parentId: m.parentId ?? null })))
    const list = ordered.length ? ordered : this.order.map((id) => this.messages.get(id)!)
    return { id: this.meta?.id ?? chatId, title: this.meta ? chatTitle(this.meta) : 'New chat', messages: list.map(toWorkMessage) }
  }
}
