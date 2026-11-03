import type { ChatEvent, Conversation, DisplayItem } from '@shared/types'

/** Pure reducer: fold a streamed ChatEvent into the display items. */
export function applyChatEvent(items: DisplayItem[], e: ChatEvent): DisplayItem[] {
  switch (e.type) {
    case 'delta': {
      const last = items[items.length - 1]
      if (last?.kind === 'assistant') return [...items.slice(0, -1), { ...last, text: last.text + e.text }]
      return [...items, { kind: 'assistant', text: e.text }]
    }
    case 'tool_pending':
      return [...items, { kind: 'tool', id: e.id, server: e.server, tool: e.tool, args: e.args, status: 'pending' }]
    case 'tool_running':
      return updateLastTool(items, e.id, (i) => ({ ...i, status: 'running' }))
    case 'tool_result':
      return updateLastTool(items, e.id, (i) => ({ ...i, status: e.denied ? 'denied' : e.isError ? 'error' : 'done', result: e.text }))
    case 'error':
      return [...items, { kind: 'error', text: e.message }]
    default:
      return items
  }
}

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>

/** Providers should use unique tool call ids, but if one repeats only the newest card is updated. */
function updateLastTool(items: DisplayItem[], id: string, f: (i: ToolItem) => ToolItem): DisplayItem[] {
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n]!
    if (i.kind === 'tool' && i.id === id) return [...items.slice(0, n), f(i), ...items.slice(n + 1)]
  }
  return items
}

export function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'New chat'
}

export function newConversation(model: string): Conversation {
  return { id: crypto.randomUUID(), title: 'New chat', updatedAt: Date.now(), model, items: [], wire: [] }
}

/** Tool calls left pending/running by an interrupted run must not look live after reload. */
export function settleInterrupted(items: DisplayItem[]): DisplayItem[] {
  return items.map((i) => (i.kind === 'tool' && (i.status === 'pending' || i.status === 'running') ? { ...i, status: 'error' as const, result: i.result ?? 'Interrupted' } : i))
}
