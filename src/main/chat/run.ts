import type { ChatEvent, WireMessage } from '../../shared/types'
import type { ToolProvider } from '../mcp/host'
import { MistralError, streamChat } from './mistral'

export interface RunDeps {
  apiBase: string
  apiKey: string
  model: string
  tools: ToolProvider
  emit: (e: ChatEvent) => void
  /** Resolves true to run the tool. Called once per tool call, before it runs. */
  approve: (call: { id: string; server: string; tool: string; args: string }) => Promise<boolean>
  signal: AbortSignal
  fetchImpl?: typeof fetch
  maxSteps?: number
}

const SYSTEM = 'You are a helpful assistant. Use the provided tools when they help answer the question.'

/**
 * Runs one user turn: stream the model, execute requested tools (after approval), feed results
 * back, repeat until the model answers without tool calls. Emits `wire` with all new wire messages
 * so the caller can persist the exact history.
 */
export async function runChat(history: WireMessage[], deps: RunDeps): Promise<void> {
  const messages: WireMessage[] = history[0]?.role === 'system' ? [...history] : [{ role: 'system', content: SYSTEM }, ...history]
  const baseLen = messages.length
  const tools = deps.tools.tools()
  const max = deps.maxSteps ?? 8
  try {
    for (let step = 0; step < max; step++) {
      let text = ''
      let toolCalls: { id: string; name: string; arguments: string }[] = []
      for await (const part of streamChat({ apiBase: deps.apiBase, apiKey: deps.apiKey, model: deps.model, messages, tools, signal: deps.signal, fetchImpl: deps.fetchImpl })) {
        if (part.type === 'text') {
          text += part.text
          deps.emit({ type: 'delta', text: part.text })
        } else toolCalls = part.toolCalls
      }
      const assistant: WireMessage = { role: 'assistant', content: text }
      if (toolCalls.length) assistant.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
      messages.push(assistant)
      if (!toolCalls.length) break

      for (const c of toolCalls) {
        const info = deps.tools.describe(c.name) ?? { server: '?', tool: c.name }
        deps.emit({ type: 'tool_pending', id: c.id, server: info.server, tool: info.tool, args: c.arguments })
        const ok = await deps.approve({ id: c.id, ...info, args: c.arguments })
        let content: string
        if (!ok) {
          content = 'The user denied this tool call.'
          deps.emit({ type: 'tool_result', id: c.id, text: content, isError: true, denied: true })
        } else {
          deps.emit({ type: 'tool_running', id: c.id })
          let args: unknown = {}
          let badJson = false
          try {
            args = c.arguments ? JSON.parse(c.arguments) : {}
          } catch {
            badJson = true
          }
          const res = badJson ? { text: 'Invalid JSON arguments', isError: true } : await deps.tools.call(c.name, args, deps.signal)
          content = res.text
          deps.emit({ type: 'tool_result', id: c.id, text: res.text, isError: res.isError })
        }
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content })
      }
      if (step === max - 1) deps.emit({ type: 'error', message: `Stopped after ${max} tool steps.` })
    }
    deps.emit({ type: 'wire', messages: messages.slice(baseLen) })
    deps.emit({ type: 'done' })
  } catch (e) {
    if (deps.signal.aborted) {
      // Keep the history valid: every tool call in an assistant message needs a tool reply.
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
      const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
      for (const tc of lastAssistant?.tool_calls ?? []) {
        if (!answered.has(tc.id)) messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: 'Cancelled by the user.' })
      }
      deps.emit({ type: 'wire', messages: messages.slice(baseLen) })
      deps.emit({ type: 'done' })
      return
    }
    deps.emit({ type: 'error', message: e instanceof MistralError ? e.message : (e as Error).message })
  }
}
