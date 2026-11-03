import { useCallback, useEffect, useRef, useState } from 'react'
import type { CodeEvent, CodeMode, CodeSessionInfo, CodeStartResult, CodeWorkspace, PermissionOption } from '@shared/types'
import { applyCodeUpdate, replayHistory, type CodeItem, type CodeState } from '../codeState'
import { Collapsible, Diff, Markdown, PlainText } from '../components'
import { SidebarPortal } from '../sidebar'
import { WorkspaceList, folderName } from './WorkspaceList'

type Status = 'idle' | 'starting' | 'ready' | 'needs-auth' | 'error' | 'exited'
interface Perm { requestId: string; title: string; options: PermissionOption[] }

export function CodeView({ goSettings, active }: { goSettings: () => void; active: boolean }) {
  const [folder, setFolder] = useState<string>()
  const [workspaces, setWorkspaces] = useState<CodeWorkspace[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [auth, setAuth] = useState<{ id: string; methods: { id: string; name: string }[] }>()
  const [modes, setModes] = useState<CodeMode[]>([])
  const [mode, setMode] = useState('')
  const [state, setState] = useState<CodeState>({ items: [] })
  const [busy, setBusy] = useState(false)
  const [perms, setPerms] = useState<Perm[]>([])
  const [input, setInput] = useState('')
  const [canResume, setCanResume] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sessions, setSessions] = useState<CodeSessionInfo[] | null>(null)
  const idRef = useRef<string | undefined>(undefined)
  const buffered = useRef(new Map<string, CodeEvent[]>())
  const bottom = useRef<HTMLDivElement>(null)

  const handle = (e: CodeEvent): void => {
    switch (e.type) {
      case 'update':
        setState((s) => applyCodeUpdate(s, e.update))
        if (e.update.sessionUpdate === 'current_mode_update' && typeof e.update.currentModeId === 'string') setMode(e.update.currentModeId)
        break
      case 'permission': setPerms((p) => [...p, { requestId: e.requestId, title: e.title, options: e.options }]); break
      case 'turn-end':
        setBusy(false)
        setPerms([])
        void refreshWorkspaces() // the session now has a title
        if (e.stopReason !== 'end_turn') setState((s) => ({ ...s, items: [...s.items, { kind: 'info', text: `Turn ended: ${e.stopReason}` }] }))
        break
      case 'error': setBusy(false); setState((s) => ({ ...s, items: [...s.items, { kind: 'error', text: e.message }] })); break
      case 'exit': setBusy(false); setStatus('exited'); setMessage(`The Vibe process exited (code ${e.code ?? 'unknown'}). Choose the folder again to restart.`); break
    }
  }

  // Show the known folders at once, then fill in their sessions once Vibe has answered.
  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    const st = await window.api.settings.get()
    setWorkspaces((prev) => st.recentFolders.map((path) => prev.find((w) => w.path === path) ?? { path, sessions: [] }))
    setWorkspaces(await window.api.code.workspaces())
  }, [])
  useEffect(() => {
    if (active) void refreshWorkspaces()
  }, [active, refreshWorkspaces])

  useEffect(() => {
    return window.api.code.onEvent((id, e) => {
      // Events can arrive before start() resolves; keep them until we know the session id.
      if (idRef.current === id) handle(e)
      else buffered.current.set(id, [...(buffered.current.get(id) ?? []), e])
    })
  }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [state.items, perms])

  const adopt = (r: CodeStartResult): void => {
    if (r.status === 'ready') {
      idRef.current = r.id
      setStatus('ready'); setModes(r.modes); setMode(r.currentMode); setAuth(undefined); setMessage(''); setCanResume(r.canResume); setShowHistory(false); setSessions(null)
      for (const e of buffered.current.get(r.id) ?? []) handle(e)
      buffered.current.delete(r.id)
      void refreshWorkspaces()
    } else if (r.status === 'needs-auth') {
      idRef.current = r.id
      setStatus('needs-auth'); setMessage(r.message); setAuth({ id: r.id, methods: r.authMethods })
    } else { setStatus('error'); setMessage(r.message) }
  }

  /** Start Vibe in `dir`: a fresh session, or one of the folder's stored sessions when `sessionId` is given. */
  const begin = async (dir: string, sessionId?: string): Promise<void> => {
    if (idRef.current) void window.api.code.stop(idRef.current)
    idRef.current = undefined
    setFolder(dir); setStatus('starting'); setState({ items: [] }); setPerms([]); setBusy(false); setMessage(''); setActiveSessionId(undefined); setSearching(false)
    const r = await window.api.code.start(dir)
    adopt(r)
    if (r.status === 'ready' && sessionId) await load(r.id, sessionId)
  }
  const choose = async (): Promise<void> => {
    const dir = await window.api.code.pickFolder()
    if (dir) await begin(dir)
  }
  const signIn = async (methodId: string): Promise<void> => {
    if (!auth) return
    setStatus('starting'); setMessage('Complete the sign-in in your browser…')
    adopt(await window.api.code.authenticate(auth.id, methodId))
  }
  const send = (): void => {
    const text = input.trim()
    if (!text || busy || status !== 'ready' || !idRef.current) return
    setState((s) => ({ ...s, items: [...s.items, { kind: 'user', text }] }))
    setInput(''); setBusy(true)
    void window.api.code.prompt(idRef.current, text)
  }
  const toggleHistory = async (): Promise<void> => {
    const open = !showHistory
    setShowHistory(open)
    if (open && idRef.current) {
      setSessions(null)
      setSessions(await window.api.code.listSessions(idRef.current))
    }
  }
  const load = async (id: string, sessionId: string): Promise<void> => {
    const r = await window.api.code.resume(id, sessionId)
    if (r.status === 'ready') {
      setState({ ...replayHistory(r.history), mode: r.currentMode })
      setModes(r.modes); setMode(r.currentMode); setPerms([]); setBusy(false); setActiveSessionId(sessionId)
    } else setState((s) => ({ ...s, items: [...s.items, { kind: 'error', text: `Could not resume: ${r.message}` }] }))
  }
  const resume = async (sessionId: string): Promise<void> => {
    if (!idRef.current || busy) return
    setShowHistory(false)
    await load(idRef.current, sessionId)
  }
  const matches = workspaces
    .map((w) => ({ ...w, sessions: w.sessions.filter((x) => !query.trim() || (x.title + ' ' + w.path).toLowerCase().includes(query.trim().toLowerCase())) }))
    .filter((w) => !query.trim() || w.sessions.length || w.path.toLowerCase().includes(query.trim().toLowerCase()))
  const answer = (p: Perm, optionId: string | null): void => {
    setPerms((ps) => ps.filter((x) => x.requestId !== p.requestId))
    void window.api.code.respondPermission(idRef.current!, p.requestId, optionId)
  }

  const sidebar = (
    <SidebarPortal tab="code">
      <div className="sidenav">
        <button className="navbtn" onClick={() => void choose()}><span aria-hidden="true">＋</span> New</button>
        <button className="navbtn" onClick={() => { setQuery(''); setSearching(true) }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg> Search
        </button>
      </div>
      <WorkspaceList workspaces={workspaces} variant="side" activeFolder={folder} activeSessionId={activeSessionId} onNewSession={(p) => void begin(p)} onOpen={(p, sid) => void begin(p, sid)} />
    </SidebarPortal>
  )
  const searchDialog = searching && (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSearching(false) }}>
      <div className="modal search" role="dialog" aria-modal="true" aria-label="Search workspaces and sessions">
        <div className="searchhead">
          <input autoFocus value={query} placeholder="Search workspaces and sessions…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setSearching(false) }} />
          <button className="iconbtn" aria-label="Close search" title="Close (Esc)" onClick={() => setSearching(false)}>✕</button>
        </div>
        <div className="searchbody">
          {!matches.length && <div className="muted">Nothing found.</div>}
          {matches.map((w) => (
            <div key={w.path} className="searchgroup">
              <button className="searchws" title={w.path} onClick={() => void begin(w.path)}>📁 {folderName(w.path)} <span className="muted">New session</span></button>
              {w.sessions.map((x) => (
                <button key={x.sessionId} className="searchitem" onClick={() => void begin(w.path, x.sessionId)}>
                  <span className="historytitle">{x.title}</span>
                  <span className="muted">{x.updatedAt ? new Date(x.updatedAt).toLocaleDateString() : ''}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  if (!folder || status === 'idle') {
    return (
      <>
        {sidebar}
        {searchDialog}
        <div className="center dashboard">
          <h2>Code</h2>
          <p className="muted">Pick a project folder. Mistral Vibe runs inside it and can read and edit files there.</p>
          <button className="primary" onClick={() => void choose()}>Choose folder…</button>
          {!!workspaces.length && <WorkspaceList workspaces={workspaces} variant="cards" onNewSession={(p) => void begin(p)} onOpen={(p, sid) => void begin(p, sid)} />}
        </div>
      </>
    )
  }

  return (
    <>
    {sidebar}
    {searchDialog}
    <div className="content">
      <header className="bar">
        <span className="folder" title={folder}>📁 {folder}</span>
        <button onClick={() => void choose()}>Change…</button>
        {status === 'ready' && canResume && <button onClick={() => void toggleHistory()} disabled={busy} aria-expanded={showHistory}>History</button>}
        {status === 'ready' && modes.length > 0 && (
          <label>Mode{' '}
            <select value={mode} className={mode === 'auto-approve' ? 'warn' : ''} onChange={(e) => { setMode(e.target.value); void window.api.code.setMode(idRef.current!, e.target.value) }}>
              {modes.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
            </select>
          </label>
        )}
        {state.usage && <span className="muted" title="Context used">{Math.round((100 * state.usage.used) / state.usage.size)}% context</span>}
      </header>
      {state.title && <div className="muted subtitle">{state.title}</div>}
      {showHistory && (
        <div className="history" role="region" aria-label="Previous sessions">
          {sessions === null && <div className="muted">Loading…</div>}
          {sessions?.length === 0 && <div className="muted">No earlier sessions in this folder.</div>}
          {sessions?.map((s) => (
            <button key={s.sessionId} className="historyitem" onClick={() => void resume(s.sessionId)}>
              <span className="historytitle">{s.title}</span>
              <span className="muted">{s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}</span>
            </button>
          ))}
        </div>
      )}
      {status === 'starting' && <div className="banner">{message || 'Starting Vibe…'}</div>}
      {status === 'needs-auth' && (
        <div className="banner">
          <p>{message}</p>
          <div className="row">
            {auth?.methods.map((m) => <button key={m.id} className="primary" onClick={() => void signIn(m.id)}>{m.name}</button>)}
            <button onClick={goSettings}>Use an API key instead</button>
          </div>
        </div>
      )}
      {(status === 'error' || status === 'exited') && (
        <div className="banner error" role="alert">
          <p>{message}</p>
          <div className="row"><button onClick={() => void begin(folder)}>Retry</button><button onClick={goSettings}>Settings</button></div>
        </div>
      )}
      <div className="messages">
        {status === 'ready' && !state.items.length && <div className="empty">Describe a task for the agent. File edits show up as diffs.</div>}
        {state.items.map((it, i) => <CodeRow key={i} item={it} />)}
        {busy && !perms.length && <div className="muted thinking">…</div>}
        {perms.map((p) => (
          <div key={p.requestId} className="toolcard pending" role="alertdialog" aria-label="Permission request">
            <div className="toolhead">Permission needed: <strong>{p.title}</strong></div>
            <div className="row">
              {p.options.map((o) => <button key={o.optionId} className={o.kind.startsWith('allow') ? 'primary' : ''} onClick={() => answer(p, o.optionId)}>{o.name}</button>)}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea value={input} disabled={status !== 'ready'} rows={2} placeholder="Tell the agent what to do…  (Enter to send)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
        {busy
          ? <button type="button" className="danger" onClick={() => void window.api.code.cancel(idRef.current!)}>Stop</button>
          : <button type="submit" className="primary" disabled={status !== 'ready' || !input.trim()}>Send</button>}
      </form>
    </div>
    </>
  )
}

function CodeRow({ item }: { item: CodeItem }) {
  switch (item.kind) {
    case 'user': return <div className="msg user"><PlainText text={item.text} /></div>
    case 'agent': return <div className="msg assistant"><Markdown text={item.text} /></div>
    case 'thought': return <Collapsible summary="Thinking"><div className="muted"><Markdown text={item.text} /></div></Collapsible>
    case 'error': return <div className="msg error" role="alert">{item.text}</div>
    case 'info': return <div className="muted center-text">{item.text}</div>
    case 'tool':
      return (
        <div className={`toolcard ${item.status}`}>
          <div className="toolhead"><span className="kind">{item.toolKind}</span> {item.title} <span className={`badge ${item.status}`}>{item.status}</span></div>
          {item.diffs.map((d, i) => <Diff key={i} d={d} />)}
          {item.text && <Collapsible summary="Output"><pre className="toolargs">{item.text}</pre></Collapsible>}
        </div>
      )
  }
}
