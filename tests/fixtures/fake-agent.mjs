#!/usr/bin/env node
// Fake ACP agent for tests. Behaviour is chosen by env FAKE_MODE: normal | needsauth | noresume
import readline from 'node:readline'
const mode = process.env.FAKE_MODE || 'normal'
const w = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
let authed = mode !== 'needsauth'
let permResolve
let current = 's1'
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') {
    const caps = mode === 'noresume' ? {} : { loadSession: true, sessionCapabilities: { list: {}, close: {} } }
    w({ id: m.id, result: { protocolVersion: 1, authMethods: mode === 'needsauth' ? [{ id: 'browser-auth', name: 'Sign in' }] : [], agentInfo: { name: 'fake', version: '1' }, agentCapabilities: caps } })
  } else if (m.method === 'authenticate') {
    authed = true
    w({ id: m.id, result: {} })
  } else if (m.method === 'session/new') {
    if (!authed) return w({ id: m.id, error: { code: -32000, message: 'Missing API key for mistral provider.' } })
    process.stderr.write('mcp:' + JSON.stringify(m.params.mcpServers) + '\n')
    w({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'n', content: { type: 'text', text: 'new-servers=' + JSON.stringify(m.params.mcpServers) } } } })
    w({ id: m.id, result: { sessionId: 's1', modes: { currentModeId: 'accept-edits', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'accept-edits', name: 'Accept Edits' }] } } })
  } else if (m.method === 'session/list') {
    w({ id: m.id, result: { sessions: [
      { sessionId: 'old-1', cwd: m.params.cwd, title: 'Old chat', updatedAt: '2026-01-01T00:00:00+00:00' },
      { sessionId: 's1', cwd: m.params.cwd, title: 'current', updatedAt: '2026-06-01T00:00:00+00:00' },
      { sessionId: 'old-2', cwd: m.params.cwd, title: null, updatedAt: '2026-03-01T00:00:00+00:00' }
    ] } })
  } else if (m.method === 'session/load') {
    if (m.params.sessionId !== 'old-1') return w({ id: m.id, error: { code: -32602, message: 'Session not found' } })
    const upd = (u) => w({ method: 'session/update', params: { sessionId: 'old-1', update: u } })
    upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } })
    upd({ sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'earlier answer' } })
    upd({ sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'load-servers=' + JSON.stringify(m.params.mcpServers) } })
    current = 'old-1'
    w({ id: m.id, result: { modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] } } })
  } else if (m.method === 'session/close') {
    w({ id: m.id, result: {} })
  } else if (m.method === 'session/set_mode') {
    w({ id: m.id, result: {} })
  } else if (m.method === 'session/prompt') {
    const text = m.params.prompt[0].text
    const upd = (u) => w({ method: 'session/update', params: { sessionId: 's1', update: u } })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: ' + text + ' session=' + m.params.sessionId } })
    if (text === 'ask') {
      w({ id: 900, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'Run ls' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
      new Promise((r) => (permResolve = r)).then((outcome) => {
        upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'outcome=' + JSON.stringify(outcome) } })
        w({ id: m.id, result: { stopReason: outcome.outcome === 'cancelled' ? 'cancelled' : 'end_turn' } })
      })
    } else w({ id: m.id, result: { stopReason: 'end_turn' } })
  } else if (m.method === 'session/cancel') {
    permResolve?.({ outcome: 'cancelled' })
  } else if (m.id === 900 && m.result) {
    permResolve?.(m.result.outcome)
  }
})
