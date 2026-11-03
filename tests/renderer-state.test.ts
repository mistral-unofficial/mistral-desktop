import { describe, expect, it } from 'vitest'
import { applyChatEvent, settleInterrupted, titleFrom } from '../src/renderer/src/chatState'
import { applyCodeUpdate, lineDiff, type CodeState } from '../src/renderer/src/codeState'
import type { DisplayItem } from '../src/shared/types'

describe('applyChatEvent', () => {
  it('appends deltas to the open assistant item and starts a new one after a tool', () => {
    let items: DisplayItem[] = [{ kind: 'user', text: 'hi' }]
    for (const e of [{ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }] as const) items = applyChatEvent(items, e)
    expect(items[1]).toEqual({ kind: 'assistant', text: 'ab' })
    items = applyChatEvent(items, { type: 'tool_pending', id: 't', server: 's', tool: 'x', args: '{}' })
    items = applyChatEvent(items, { type: 'tool_running', id: 't' })
    expect(items[2]).toMatchObject({ kind: 'tool', status: 'running' })
    items = applyChatEvent(items, { type: 'tool_result', id: 't', text: 'r', isError: false })
    expect(items[2]).toMatchObject({ status: 'done', result: 'r' })
    items = applyChatEvent(items, { type: 'delta', text: 'c' })
    expect(items[3]).toEqual({ kind: 'assistant', text: 'c' })
  })
  it('marks denied and errored tools distinctly', () => {
    const base: DisplayItem[] = [{ kind: 'tool', id: 't', server: 's', tool: 'x', args: '', status: 'pending' }]
    expect(applyChatEvent(base, { type: 'tool_result', id: 't', text: '', isError: true, denied: true })[0]).toMatchObject({ status: 'denied' })
    expect(applyChatEvent(base, { type: 'tool_result', id: 't', text: '', isError: true })[0]).toMatchObject({ status: 'error' })
  })
  it('settles interrupted tools and builds titles', () => {
    expect(settleInterrupted([{ kind: 'tool', id: 't', server: '', tool: '', args: '', status: 'running' }])[0]).toMatchObject({ status: 'error' })
    expect(titleFrom('  hello\n  world ')).toBe('hello world')
    expect(titleFrom('x'.repeat(100))).toHaveLength(48)
    expect(titleFrom('   ')).toBe('New chat')
  })
})

describe('applyCodeUpdate', () => {
  const empty: CodeState = { items: [] }
  it('merges message chunks and separates thoughts', () => {
    let s = applyCodeUpdate(empty, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } })
    s = applyCodeUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    s = applyCodeUpdate(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })
    expect(s.items).toEqual([{ kind: 'agent', text: 'Hello' }, { kind: 'thought', text: 'hmm' }])
  })
  it('tracks a tool call with a diff through its updates (shapes seen from real vibe-acp)', () => {
    let s = applyCodeUpdate(empty, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'write_file', kind: 'edit', status: 'pending', content: [{ type: 'diff', path: 'hello.txt', newText: 'hi\n' }] })
    s = applyCodeUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: '/abs/hello.txt', newText: 'hi\n' }, { type: 'content', content: { type: 'text', text: 'Created hello.txt' } }] })
    expect(s.items[0]).toMatchObject({ kind: 'tool', status: 'completed', text: 'Created hello.txt', diffs: [{ path: '/abs/hello.txt' }] })
    expect(s.items).toHaveLength(1)
  })
  it('keeps the old diff when an update carries none, ignores unknown updates', () => {
    let s = applyCodeUpdate(empty, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', content: [{ type: 'diff', path: 'a', newText: 'n' }] })
    s = applyCodeUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'failed' })
    expect(s.items[0]).toMatchObject({ status: 'failed', diffs: [{ path: 'a' }] })
    expect(applyCodeUpdate(s, { sessionUpdate: 'mystery' })).toBe(s)
  })
  it('records title, mode and usage', () => {
    let s = applyCodeUpdate(empty, { sessionUpdate: 'session_info_update', title: 'T' })
    s = applyCodeUpdate(s, { sessionUpdate: 'current_mode_update', currentModeId: 'ask' })
    s = applyCodeUpdate(s, { sessionUpdate: 'usage_update', used: 5, size: 100 })
    expect(s).toMatchObject({ title: 'T', mode: 'ask', usage: { used: 5, size: 100 } })
  })
})

describe('regressions found in the e2e run', () => {
  it('a repeated tool call id only updates the newest card', () => {
    let items: DisplayItem[] = []
    for (const status of ['denied', 'ok'] as const) {
      items = applyChatEvent(items, { type: 'tool_pending', id: 'call1', server: 's', tool: 'x', args: '{}' })
      items = applyChatEvent(items, { type: 'tool_result', id: 'call1', text: status, isError: status === 'denied', denied: status === 'denied' })
    }
    expect(items.map((i) => (i.kind === 'tool' ? i.status : ''))).toEqual(['denied', 'done'])
  })
  it('agent chunks with different messageIds become separate bubbles', () => {
    const chunk = (text: string, messageId?: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId })
    let s: CodeState = { items: [] }
    for (const c of [chunk('notice.', 'n1'), chunk('Reply ', 'a1'), chunk('text', 'a1')]) s = applyCodeUpdate(s, c)
    expect(s.items).toMatchObject([{ text: 'notice.' }, { text: 'Reply text' }])
  })
})

describe('lineDiff', () => {
  it('does not show a phantom empty line for a trailing newline', () => {
    expect(lineDiff(null, 'hi\n')).toEqual([{ type: 'add', text: 'hi' }])
    expect(lineDiff('a\n', 'a\nb\n')).toEqual([{ type: 'same', text: 'a' }, { type: 'add', text: 'b' }])
  })
  it('marks a new file as all additions', () => {
    expect(lineDiff(null, 'a\nb')).toEqual([{ type: 'add', text: 'a' }, { type: 'add', text: 'b' }])
  })
  it('finds minimal changes', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc')).toEqual([{ type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'add', text: 'X' }, { type: 'same', text: 'c' }])
  })
})
