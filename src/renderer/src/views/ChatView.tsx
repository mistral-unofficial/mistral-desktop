import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent, Conversation, ConversationHit, DisplayItem, McpServerStatus, SettingsView } from '@shared/types'
import { applyChatEvent, newConversation, settleInterrupted, titleFrom } from '../chatState'
import { Collapsible, Markdown, PlainText } from '../components'
import type { SettingsSection } from '../settingsSections'
import { SidebarPortal } from '../sidebar'

type Summary = Pick<Conversation, 'id' | 'title' | 'updatedAt'>

export function ChatView({ goSettings, active }: { goSettings: (section?: SettingsSection) => void; active: boolean }) {
  const [settings, setSettings] = useState<SettingsView>()
  const [models, setModels] = useState<string[]>([])
  const [list, setList] = useState<Summary[]>([])
  const [conv, setConv] = useState<Conversation>(() => newConversation(''))
  const [input, setInput] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [autoApprove, setAutoApprove] = useState(false)
  const [mcp, setMcp] = useState<McpServerStatus[]>([])
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ConversationHit[]>([])
  const reqRef = useRef<string | null>(null)
  const autoRef = useRef(false)
  const bottom = useRef<HTMLDivElement>(null)
  autoRef.current = autoApprove
  const streaming = requestId !== null

  useEffect(() => {
    if (!searching) return
    let stale = false
    const t = setTimeout(() => void window.api.conversations.search(query).then((h) => !stale && setHits(h)), 120)
    return () => { stale = true; clearTimeout(t) }
  }, [searching, query])

  const refreshList = useCallback(() => void window.api.conversations.list().then(setList), [])

  // Settings (API key, default model) can change in the Settings tab: re-read whenever this tab is shown.
  useEffect(() => {
    if (!active) return
    void window.api.settings.get().then((s) => {
      setSettings(s)
      setConv((c) => (c.model ? c : { ...c, model: s.model }))
    })
    void window.api.chat.models().then(setModels)
    void window.api.mcp.status().then(setMcp)
  }, [active])

  useEffect(() => {
    refreshList()
    const offMcp = window.api.mcp.onChange(setMcp)
    const off = window.api.chat.onEvent((rid: string, e: ChatEvent) => {
      if (rid !== reqRef.current) return
      if (e.type === 'tool_pending' && autoRef.current) void window.api.chat.approve(e.id, true)
      if (e.type === 'wire') setConv((c) => ({ ...c, wire: [...c.wire, ...e.messages] }))
      else if (e.type === 'done') {
        reqRef.current = null
        setRequestId(null)
      } else {
        setConv((c) => ({ ...c, items: applyChatEvent(c.items, e) }))
        if (e.type === 'error') {
          reqRef.current = null
          setRequestId(null)
        }
      }
    })
    return () => (off(), offMcp())
  }, [refreshList])

  // Persist when a turn settles (not on every streamed token).
  useEffect(() => {
    if (!streaming && conv.items.length) {
      const saved = { ...conv, items: settleInterrupted(conv.items), updatedAt: Date.now() }
      void window.api.conversations.save(saved).then(refreshList)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [conv.items])

  const send = (): void => {
    const text = input.trim()
    if (!text || streaming) return
    const rid = crypto.randomUUID()
    const wire = [...conv.wire, { role: 'user' as const, content: text }]
    const next: Conversation = { ...conv, title: conv.items.length ? conv.title : titleFrom(text), items: [...settleInterrupted(conv.items), { kind: 'user', text }], wire }
    setConv(next)
    setInput('')
    reqRef.current = rid
    setRequestId(rid)
    void window.api.chat.send({ requestId: rid, messages: wire, model: conv.model })
  }

  const open = async (id: string): Promise<void> => {
    const c = await window.api.conversations.get(id)
    if (c) setConv(c)
  }
  const remove = async (id: string): Promise<void> => {
    await window.api.conversations.remove(id)
    if (id === conv.id) setConv(newConversation(conv.model))
    refreshList()
  }

  const needAuth = mcp.filter((m) => m.state === 'needs-auth')
  const connected = mcp.filter((m) => m.state === 'connected')
  const toolCount = connected.reduce((n, m) => n + m.tools.length, 0)

  return (
    <div className="split">
      <SidebarPortal tab="chat">
        <div className="sidenav">
          <button className="navbtn" disabled={streaming} onClick={() => setConv(newConversation(conv.model))}><span aria-hidden="true">＋</span> New</button>
          <button className="navbtn" onClick={() => { setQuery(''); setSearching(true) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg> Search
          </button>
        </div>
        <ul className="convlist">
          {list.map((c) => (
            <li key={c.id} className={c.id === conv.id ? 'active' : ''}>
              <button className="convbtn" disabled={streaming} onClick={() => void open(c.id)} title={c.title}>{c.title}</button>
              <button className="iconbtn" aria-label={`Delete ${c.title}`} disabled={streaming} onClick={() => void remove(c.id)}>✕</button>
            </li>
          ))}
        </ul>
      </SidebarPortal>
      {searching && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSearching(false) }}>
          <div className="modal search" role="dialog" aria-modal="true" aria-label="Search chats">
            <div className="searchhead">
              <input autoFocus value={query} placeholder="Search chats…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setSearching(false) }} />
              <button className="iconbtn" aria-label="Close search" title="Close (Esc)" onClick={() => setSearching(false)}>✕</button>
            </div>
            <div className="searchbody">
              {!hits.length && <div className="muted">Nothing found.</div>}
              {hits.map((h) => (
                <button key={h.id} className="searchitem chat" disabled={streaming} onClick={() => { setSearching(false); void open(h.id) }}>
                  <span className="historytitle">{h.title}</span>
                  <span className="muted">{new Date(h.updatedAt).toLocaleDateString()}</span>
                  {h.snippet && <span className="muted snippet">{h.snippet}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="content">
        <header className="bar">
          <label>Model{' '}
            <select value={conv.model} disabled={streaming || !!conv.items.length} onChange={(e) => setConv({ ...conv, model: e.target.value })}>
              {[...new Set([conv.model, ...models])].filter(Boolean).map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="check" title="Run tool calls without asking. Only enable for servers you trust.">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} /> Auto-approve tools
          </label>
          <ConnectorsButton servers={connected} toolCount={toolCount} />
        </header>
        {needAuth.length > 0 && (
          <div className="banner">{needAuth.map((m) => m.name).join(', ')} {needAuth.length === 1 ? 'needs' : 'need'} you to sign in. <button className="linklike" onClick={() => goSettings('connectors')}>Open Settings</button></div>
        )}
        {settings && !settings.hasApiKey && (
          <div className="banner">No Mistral API key yet. <button className="linklike" onClick={() => goSettings('account')}>Add one in Settings</button> to start chatting.</div>
        )}
        <div className="messages" aria-live="polite">
          {!conv.items.length && <div className="empty">Ask anything. Tools from your MCP servers are available to the model.</div>}
          {conv.items.map((it, i) => <ChatItem key={i} item={it} />)}
          {streaming && <div className="muted thinking">…</div>}
          <div ref={bottom} />
        </div>
        <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
          <textarea
            value={input}
            placeholder="Message Mistral…  (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
            rows={2}
          />
          {streaming
            ? <button type="button" className="danger" onClick={() => void window.api.chat.cancel(reqRef.current!)}>Stop</button>
            : <button type="submit" className="primary" disabled={!input.trim()}>Send</button>}
        </form>
      </div>
    </div>
  )
}

function ChatItem({ item }: { item: DisplayItem }) {
  switch (item.kind) {
    case 'user': return <div className="msg user"><PlainText text={item.text} /></div>
    case 'assistant': return <div className="msg assistant"><Markdown text={item.text} /></div>
    case 'error': return <div className="msg error" role="alert">{item.text}</div>
    case 'tool': return <ToolCard item={item} />
  }
}

function ToolCard({ item }: { item: Extract<DisplayItem, { kind: 'tool' }> }) {
  const pretty = (() => { try { return JSON.stringify(JSON.parse(item.args), null, 2) } catch { return item.args } })()
  return (
    <div className={`toolcard ${item.status}`}>
      <div className="toolhead">
        <strong>{item.server}</strong> › {item.tool} <span className={`badge ${item.status}`}>{item.status}</span>
      </div>
      <pre className="toolargs">{pretty}</pre>
      {item.status === 'pending' && (
        <div className="row">
          <button className="primary" onClick={() => void window.api.chat.approve(item.id, true)}>Allow</button>
          <button onClick={() => void window.api.chat.approve(item.id, false)}>Deny</button>
        </div>
      )}
      {item.result !== undefined && <Collapsible summary="Result"><pre className="toolargs">{item.result}</pre></Collapsible>}
    </div>
  )
}

function ConnectorsButton({ servers, toolCount }: { servers: McpServerStatus[]; toolCount: number }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const label = `Connectors: ${servers.length} connected, ${toolCount} tool${toolCount === 1 ? '' : 's'}`
  return (
    <div className="connectors" ref={ref}>
      <button className="connectors-btn" aria-label={label} title={label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7zM12 17v5" />
        </svg>
        <span className="connectors-count">{servers.length}</span>
      </button>
      {open && (
        <div className="connectors-pop" role="menu">
          {!servers.length && <div className="muted connectors-empty">No connected MCP servers.</div>}
          {servers.map((m) => (
            <div key={m.id} className="connectors-item">
              <button className="connectors-row" aria-expanded={expanded === m.id} onClick={() => setExpanded(expanded === m.id ? null : m.id)}>
                <span className="connectors-caret">{expanded === m.id ? '▾' : '▸'}</span>
                <span className="connectors-name">{m.name}</span>
                <span className="muted">{m.tools.length}</span>
              </button>
              {expanded === m.id && (
                <ul className="connectors-tools">
                  {m.tools.map((t) => <li key={t} title={t}>{t}</li>)}
                  {!m.tools.length && <li className="muted">No tools</li>}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
