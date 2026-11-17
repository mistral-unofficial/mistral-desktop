export interface DiffContent {
  path: string
  oldText?: string | null
  newText: string
}

export type CodeItem =
  | { kind: 'user'; text: string; messageId?: string }
  | { kind: 'agent'; text: string; messageId?: string }
  | { kind: 'thought'; text: string; messageId?: string }
  | { kind: 'tool'; id: string; title: string; toolKind: string; status: string; diffs: DiffContent[]; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }

/** ACP `usage_update`: context usage plus the session stats Vibe puts in `_meta` (same source as /status). */
export interface CodeUsage {
  used: number
  size: number
  cost?: { amount: number; currency: string }
  steps?: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  totalTokens?: number
  tokensPerSecond?: number
  lastTurnDuration?: number
  lastTurnTotalTokens?: number
}

export interface CodeState {
  items: CodeItem[]
  title?: string
  mode?: string
  usage?: CodeUsage
}

type Update = Record<string, unknown> & { sessionUpdate: string }
interface RawContent {
  type?: string
  path?: string
  oldText?: string | null
  newText?: string
  content?: { type?: string; text?: string }
}

function parseContent(content: unknown): { diffs: DiffContent[]; text: string } {
  const diffs: DiffContent[] = []
  const texts: string[] = []
  for (const c of Array.isArray(content) ? (content as RawContent[]) : []) {
    if (c?.type === 'diff' && typeof c.path === 'string') diffs.push({ path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' })
    else if (c?.type === 'content' && c.content?.type === 'text' && c.content.text) texts.push(c.content.text)
  }
  return { diffs, text: texts.join('\n') }
}

const chunkText = (u: Update): string => {
  const c = u.content as { type?: string; text?: string } | undefined
  return c?.type === 'text' && typeof c.text === 'string' ? c.text : ''
}

/**
 * Fold an ACP `session/update` payload into UI state. Unknown update kinds are ignored.
 * With `replay` (a stored session being loaded) the user's own messages are included; live, the UI adds
 * those itself when sending, so the agent's echo of them is ignored.
 */
export function applyCodeUpdate(state: CodeState, u: Update, opts: { replay?: boolean } = {}): CodeState {
  const items = state.items
  switch (u.sessionUpdate) {
    case 'user_message_chunk': {
      if (!opts.replay) return state
      const text = chunkText(u)
      if (!text) return state
      const messageId = typeof u.messageId === 'string' ? u.messageId : undefined
      const last = items[items.length - 1]
      if (last && last.kind === 'user' && last.messageId === messageId) return { ...state, items: [...items.slice(0, -1), { ...last, text: last.text + text }] }
      return { ...state, items: [...items, { kind: 'user', text, messageId }] }
    }
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const kind = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : 'thought'
      const text = chunkText(u)
      if (!text) return state
      const messageId = typeof u.messageId === 'string' ? u.messageId : undefined
      const last = items[items.length - 1]
      // Chunks of one message share a messageId; a different id (e.g. a Vibe notice, then the model's reply) starts a new bubble.
      if (last && last.kind === kind && last.messageId === messageId) return { ...state, items: [...items.slice(0, -1), { ...last, text: last.text + text }] }
      return { ...state, items: [...items, { kind, text, messageId }] }
    }
    case 'tool_call': {
      const { diffs, text } = parseContent(u.content)
      const id = String(u.toolCallId ?? '')
      const item: CodeItem = { kind: 'tool', id, title: String(u.title ?? 'Tool call'), toolKind: String(u.kind ?? 'other'), status: String(u.status ?? 'pending'), diffs, text }
      // A repeated tool_call for the same id replaces the earlier entry.
      return { ...state, items: items.some((i) => i.kind === 'tool' && i.id === id) ? items.map((i) => (i.kind === 'tool' && i.id === id ? item : i)) : [...items, item] }
    }
    case 'tool_call_update': {
      const id = String(u.toolCallId ?? '')
      const { diffs, text } = parseContent(u.content)
      return {
        ...state,
        items: items.map((i) =>
          i.kind === 'tool' && i.id === id
            ? { ...i, title: typeof u.title === 'string' ? u.title : i.title, status: typeof u.status === 'string' ? u.status : i.status, diffs: diffs.length ? diffs : i.diffs, text: text || i.text }
            : i
        )
      }
    }
    case 'session_info_update':
      return typeof u.title === 'string' ? { ...state, title: u.title } : state
    case 'current_mode_update':
      return typeof u.currentModeId === 'string' ? { ...state, mode: u.currentModeId } : state
    case 'usage_update': {
      if (typeof u.used !== 'number' || typeof u.size !== 'number') return state
      const meta = (u._meta ?? {}) as Record<string, unknown>
      const num = (k: string): number | undefined => (typeof meta[k] === 'number' ? (meta[k] as number) : undefined)
      const cost = u.cost as { amount?: unknown; currency?: unknown } | undefined
      return {
        ...state,
        usage: {
          used: u.used,
          size: u.size,
          cost: typeof cost?.amount === 'number' && typeof cost.currency === 'string' ? { amount: cost.amount, currency: cost.currency } : undefined,
          steps: num('steps'),
          promptTokens: num('promptTokens'),
          completionTokens: num('completionTokens'),
          cachedTokens: num('cachedTokens'),
          totalTokens: num('totalTokens'),
          tokensPerSecond: num('tokensPerSecond'),
          lastTurnDuration: num('lastTurnDuration'),
          lastTurnTotalTokens: num('lastTurnTotalTokens')
        }
      }
    }
    default:
      return state
  }
}

export interface DiffLine {
  type: 'add' | 'del' | 'same'
  text: string
}

/** Line diff via LCS. Falls back to delete-all/add-all for very large inputs. */
export function lineDiff(oldText: string | null | undefined, newText: string): DiffLine[] {
  // A trailing newline terminates the last line; it is not an extra empty line.
  const lines = (t: string): string[] => (t === '' ? [] : t.replace(/\n$/, '').split('\n'))
  const a = lines(oldText ?? '')
  const b = lines(newText)
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))]
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (out.push({ type: 'same', text: a[i]! }), i++, j++)
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ type: 'del', text: a[i++]! })
    else out.push({ type: 'add', text: b[j++]! })
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++]! })
  while (j < b.length) out.push({ type: 'add', text: b[j++]! })
  return out
}

/** Rebuild UI state from the update stream returned when resuming a stored session. */
export function replayHistory(history: Update[]): CodeState {
  return history.reduce<CodeState>((st, u) => applyCodeUpdate(st, u, { replay: true }), { items: [] })
}
