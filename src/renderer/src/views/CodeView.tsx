import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeConfigOption, CodeEvent, CodeMode, CodeSessionInfo, CodeStartResult, CodeWorkspace, PermissionOption, CodeQuestion } from '@shared/types'
import { normalizeConfigOptions } from '@shared/config-options'
import { applyCodeUpdate, replayHistory, type CodeItem, type CodeState } from '../codeState'
import { Collapsible, Diff, Markdown, PlainText, QuestionCard } from '../components'
import { MentionTextarea } from '../MentionTextarea'
import { mergePending, type PendingSession } from '../sessions'
import type { SettingsSection } from '../settingsSections'
import { SidebarPortal } from '../sidebar'
import { WorkspaceList, folderName } from './WorkspaceList'

type Status = 'idle' | 'starting' | 'ready' | 'needs-auth' | 'error' | 'exited'
interface Ask { requestId: string; message?: string; footer?: string; questions: CodeQuestion[] }
interface Perm { requestId: string; title: string; options: PermissionOption[] }

export function CodeView({ goSettings, active }: { goSettings: (section?: SettingsSection) => void; active: boolean }) {
  const [folder, setFolder] = useState<string>()
  const [workspaces, setWorkspaces] = useState<CodeWorkspace[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>()
  // Sessions the user has started that Vibe has not listed yet: shown in the sidebar from the first message on.
  const [pending, setPending] = useState<PendingSession[]>([])
  const [notice, setNotice] = useState('')
  const [wtDialog, setWtDialog] = useState<{ path: string; branch: string; error: string; busy: boolean }>()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [auth, setAuth] = useState<{ id: string; methods: { id: string; name: string }[] }>()
  const [modes, setModes] = useState<CodeMode[]>([])
  const [mode, setMode] = useState('')
  const [configOptions, setConfigOptions] = useState<CodeConfigOption[]>([])
  const [state, setState] = useState<CodeState>({ items: [] })
  const [busy, setBusy] = useState(false)
  const [perms, setPerms] = useState<Perm[]>([])
  const [asks, setAsks] = useState<Ask[]>([])
  const [input, setInput] = useState('')
  const idRef = useRef<string | undefined>(undefined)
  const buffered = useRef(new Map<string, CodeEvent[]>())
  const bottom = useRef<HTMLDivElement>(null)

  const handle = (e: CodeEvent): void => {
    switch (e.type) {
      case 'update':
        setState((s) => applyCodeUpdate(s, e.update))
        if (e.update.sessionUpdate === 'config_option_update') setConfigOptions(normalizeConfigOptions(e.update.configOptions))
        if (e.update.sessionUpdate === 'current_mode_update' && typeof e.update.currentModeId === 'string') setMode(e.update.currentModeId)
        break
      case 'permission': setPerms((p) => [...p, { requestId: e.requestId, title: e.title, options: e.options }]); break
      case 'question': setAsks((a) => [...a, { requestId: e.requestId, message: e.message, footer: e.footer, questions: e.questions }]); break
      case 'turn-end':
        setBusy(false)
        setPerms([]); setAsks([])
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
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [state.items, perms, asks])

  const adopt = (r: CodeStartResult): void => {
    if (r.status === 'ready') {
      idRef.current = r.id
      setStatus('ready'); setModes(r.modes); setMode(r.currentMode); setAuth(undefined); setMessage(''); setActiveSessionId(r.sessionId); setConfigOptions(r.configOptions)
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
    setFolder(dir); setStatus('starting'); setState({ items: [] }); setPerms([]); setAsks([]); setBusy(false); setMessage(''); setActiveSessionId(undefined); setSearching(false)
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
    // First message of a new session: list it in the sidebar now, not when the agent has finished.
    if (folder && activeSessionId && !workspaces.some((w) => w.sessions.some((x) => x.sessionId === activeSessionId))) {
      const title = text.split('\n')[0]!.slice(0, 60)
      setPending((p) => (p.some((x) => x.session.sessionId === activeSessionId) ? p : [...p, { path: folder, session: { sessionId: activeSessionId, title, updatedAt: new Date().toISOString() } }]))
    }
    setInput(''); setBusy(true)
    void window.api.code.prompt(idRef.current, text)
  }
  const load = async (id: string, sessionId: string): Promise<void> => {
    const r = await window.api.code.resume(id, sessionId)
    if (r.status === 'ready') {
      setState({ ...replayHistory(r.history), mode: r.currentMode })
      setModes(r.modes); setMode(r.currentMode); setConfigOptions(r.configOptions); setPerms([]); setAsks([]); setBusy(false); setActiveSessionId(sessionId)
    } else setState((s) => ({ ...s, items: [...s.items, { kind: 'error', text: `Could not resume: ${r.message}` }] }))
  }
  const shown = useMemo(() => mergePending(workspaces, pending), [workspaces, pending])
  // Once Vibe lists a session, the local stand-in is no longer needed.
  useEffect(() => {
    const listed = new Set(workspaces.flatMap((w) => w.sessions.map((x) => x.sessionId)))
    setPending((p) => (p.some((x) => listed.has(x.session.sessionId)) ? p.filter((x) => !listed.has(x.session.sessionId)) : p))
  }, [workspaces])
  // Vibe names the session after its first answer: follow that title while the stand-in is shown.
  useEffect(() => {
    const t = state.title
    if (t && activeSessionId) setPending((p) => (p.some((x) => x.session.sessionId === activeSessionId && x.session.title !== t) ? p.map((x) => (x.session.sessionId === activeSessionId ? { ...x, session: { ...x.session, title: t } } : x)) : p))
  }, [state.title, activeSessionId])

  const renameSession = async (_path: string, s: CodeSessionInfo, title: string): Promise<void> => {
    const apply = (t: string): void => {
      const map = (x: CodeSessionInfo): CodeSessionInfo => (x.sessionId === s.sessionId ? { ...x, title: t } : x)
      setWorkspaces((ws) => ws.map((w) => ({ ...w, sessions: w.sessions.map(map) })))
      setPending((p) => p.map((x) => ({ ...x, session: map(x.session) })))
    }
    setNotice('')
    apply(title)
    const err = await window.api.code.renameSession(s.sessionId, title)
    if (err) { apply(s.title); setNotice(`Could not rename: ${err}`) }
    void refreshWorkspaces()
  }
  const deleteSession = async (path: string, s: CodeSessionInfo): Promise<void> => {
    if (!window.confirm(`Delete "${s.title}"? This cannot be undone.`)) return
    setNotice('')
    const wasPending = pending.some((x) => x.session.sessionId === s.sessionId)
    if (folder === path && activeSessionId === s.sessionId) {
      // The open session: leave it (the agent is stopped by the delete) and go back to the overview.
      idRef.current = undefined
      setFolder(undefined); setStatus('idle'); setState({ items: [] }); setPerms([]); setAsks([]); setBusy(false); setActiveSessionId(undefined)
    }
    setWorkspaces((ws) => ws.map((w) => ({ ...w, sessions: w.sessions.filter((x) => x.sessionId !== s.sessionId) })))
    setPending((p) => p.filter((x) => x.session.sessionId !== s.sessionId))
    const err = await window.api.code.deleteSession(s.sessionId)
    if (err && !wasPending) setNotice(`Could not delete: ${err}`) // a session Vibe never stored has nothing to delete
    void refreshWorkspaces()
  }

  const openWorktreeDialog = (path: string): void => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    setWtDialog({ path, branch: `vibe/${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`, error: '', busy: false })
  }
  const createWorktree = async (): Promise<void> => {
    if (!wtDialog || wtDialog.busy) return
    setWtDialog({ ...wtDialog, busy: true, error: '' })
    const r = await window.api.code.createWorktree(wtDialog.path, wtDialog.branch)
    if (!r.ok) return setWtDialog((d) => d && { ...d, busy: false, error: r.error })
    setWtDialog(undefined)
    await begin(r.path)
  }
  const removeWorktree = async (ws: CodeWorkspace): Promise<void> => {
    if (!ws.worktree) return
    if (!window.confirm(`Remove the worktree for "${ws.worktree.branch}"?\n\n${ws.path}\n\nThe branch and its commits are kept.`)) return
    setNotice('')
    let r = await window.api.code.removeWorktree(ws.path, false)
    if (!r.ok && r.dirty) {
      if (!window.confirm(`"${ws.worktree.branch}" has uncommitted changes that will be lost. Remove it anyway?`)) return
      r = await window.api.code.removeWorktree(ws.path, true)
    }
    if (!r.ok) return setNotice(`Could not remove the worktree: ${r.error}`)
    if (folder === ws.path) {
      idRef.current = undefined
      setFolder(undefined); setStatus('idle'); setState({ items: [] }); setPerms([]); setAsks([]); setBusy(false); setActiveSessionId(undefined)
    }
    setPending((p) => p.filter((x) => x.path !== ws.path))
    void refreshWorkspaces()
  }

  const matches = shown
    .map((w) => ({ ...w, sessions: w.sessions.filter((x) => !query.trim() || (x.title + ' ' + w.path).toLowerCase().includes(query.trim().toLowerCase())) }))
    .filter((w) => !query.trim() || w.sessions.length || w.path.toLowerCase().includes(query.trim().toLowerCase()))
  const changeConfig = async (configId: string, value: string): Promise<void> => {
    if (!idRef.current) return
    const before = configOptions
    setConfigOptions((o) => o.map((x) => (x.id === configId ? { ...x, value } : x))) // show the choice at once
    const r = await window.api.code.setConfigOption(idRef.current, configId, value)
    if (r.ok) setConfigOptions(r.options)
    else {
      setConfigOptions(before)
      setState((st) => ({ ...st, items: [...st.items, { kind: 'error', text: `Could not change ${configId}: ${r.error}` }] }))
    }
  }
  const answer = (p: Perm, optionId: string | null): void => {
    setPerms((ps) => ps.filter((x) => x.requestId !== p.requestId))
    void window.api.code.respondPermission(idRef.current!, p.requestId, optionId)
  }

  const reply = (a: Ask, answers: string[][] | null): void => {
    setAsks((as) => as.filter((x) => x.requestId !== a.requestId))
    const content = answers ? Object.fromEntries(a.questions.map((q, i) => [q.key, q.multi ? (answers[i] ?? []) : (answers[i]?.[0] ?? '')])) : null
    void window.api.code.respondQuestion(idRef.current!, a.requestId, content)
  }

  const sidebar = (
    <SidebarPortal tab="code">
      <div className="sidenav">
        <button className="navbtn" onClick={() => void choose()}><span aria-hidden="true">＋</span> New</button>
        <button className="navbtn" onClick={() => { setQuery(''); setSearching(true) }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg> Search
        </button>
      </div>
      <WorkspaceList workspaces={shown} variant="side" activeFolder={folder} activeSessionId={activeSessionId} onNewSession={(p) => void begin(p)} onOpen={(p, sid) => void begin(p, sid)} onRename={(p, x, t) => void renameSession(p, x, t)} onDelete={(p, x) => void deleteSession(p, x)} onNewWorktree={openWorktreeDialog} onRemoveWorktree={(w) => void removeWorktree(w)} />
      {notice && <p className="warnline" role="alert">{notice}</p>}
    </SidebarPortal>
  )
  const worktreeDialog = wtDialog && (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !wtDialog.busy) setWtDialog(undefined) }}>
      <form className="modal prompt" role="dialog" aria-modal="true" aria-label="New worktree" onSubmit={(e) => { e.preventDefault(); void createWorktree() }} onKeyDown={(e) => { if (e.key === 'Escape' && !wtDialog.busy) setWtDialog(undefined) }}>
        <h3>New session in a new worktree</h3>
        <p className="muted">Creates a separate git checkout of <strong>{folderName(workspaces.find((w) => w.path === wtDialog.path)?.worktree?.mainRepo ?? wtDialog.path)}</strong> on this branch, so the agent's changes stay apart from your working copy. If the branch exists it is checked out, otherwise it is created from the current commit.</p>
        <label className="field">Branch name
          <input autoFocus value={wtDialog.branch} spellCheck={false} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setWtDialog({ ...wtDialog, branch: e.target.value, error: '' })} />
        </label>
        {wtDialog.error && <p className="warnline" role="alert">{wtDialog.error}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={wtDialog.busy || !wtDialog.branch.trim()}>{wtDialog.busy ? 'Creating…' : 'Create and start'}</button>
          <button type="button" disabled={wtDialog.busy} onClick={() => setWtDialog(undefined)}>Cancel</button>
        </div>
      </form>
    </div>
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
        {worktreeDialog}
        <div className="center dashboard">
          <h2>Code</h2>
          <p className="muted">Pick a project folder. Mistral Vibe runs inside it and can read and edit files there.</p>
          <button className="primary" onClick={() => void choose()}>Choose folder…</button>
          {!!shown.length && <WorkspaceList workspaces={shown} variant="cards" onNewSession={(p) => void begin(p)} onOpen={(p, sid) => void begin(p, sid)} onRename={(p, x, t) => void renameSession(p, x, t)} onDelete={(p, x) => void deleteSession(p, x)} onNewWorktree={openWorktreeDialog} onRemoveWorktree={(w) => void removeWorktree(w)} />}
        </div>
      </>
    )
  }

  return (
    <>
    {sidebar}
    {searchDialog}
    {worktreeDialog}
    <div className="content">
      <header className="bar">
        {status === 'ready' && (['model', 'thinking'] as const).map((id) => {
          const o = configOptions.find((x) => x.id === id)
          if (!o || !o.choices.length) return null
          const only = o.choices.length === 1
          return (
            <label key={id}>{o.name}{' '}
              <select value={o.value} disabled={busy || only} title={only ? `Vibe offers only one ${o.name.toLowerCase()} here. More models can be added in Vibe's config.toml.` : o.choices.find((c) => c.value === o.value)?.description} onChange={(e) => void changeConfig(id, e.target.value)}>
                {!o.choices.some((c) => c.value === o.value) && <option value={o.value}>{o.value}</option>}
                {o.choices.map((c) => <option key={c.value} value={c.value} title={c.description}>{c.name}</option>)}
              </select>
            </label>
          )
        })}
        {status === 'ready' && modes.length > 0 && (
          <label>Mode{' '}
            <select value={mode} className={mode === 'auto-approve' ? 'warn' : ''} onChange={(e) => { setMode(e.target.value); void window.api.code.setMode(idRef.current!, e.target.value) }}>
              {modes.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
            </select>
          </label>
        )}
        {state.usage && <span className="muted ctx" title="Context used">{Math.round((100 * state.usage.used) / state.usage.size)}% context</span>}
      </header>
      {state.title && <div className="muted subtitle">{state.title}</div>}
      {status === 'starting' && <div className="banner">{message || 'Starting Vibe…'}</div>}
      {status === 'needs-auth' && (
        <div className="banner">
          <p>{message}</p>
          <div className="row">
            {auth?.methods.map((m) => <button key={m.id} className="primary" onClick={() => void signIn(m.id)}>{m.name}</button>)}
            <button onClick={() => goSettings('account')}>Use an API key instead</button>
          </div>
        </div>
      )}
      {(status === 'error' || status === 'exited') && (
        <div className="banner error" role="alert">
          <p>{message}</p>
          <div className="row"><button onClick={() => void begin(folder)}>Retry</button><button onClick={() => goSettings('account')}>Settings</button></div>
        </div>
      )}
      <div className="messages">
        {status === 'ready' && !state.items.length && <div className="empty">Describe a task for the agent. File edits show up as diffs.</div>}
        {state.items.map((it, i) => <CodeRow key={i} item={it} />)}
        {busy && !perms.length && !asks.length && <div className="muted thinking">…</div>}
        {perms.map((p) => (
          <div key={p.requestId} className="toolcard pending" role="alertdialog" aria-label="Permission request">
            <div className="toolhead">Permission needed: <strong>{p.title}</strong></div>
            <div className="row">
              {p.options.map((o) => <button key={o.optionId} className={o.kind.startsWith('allow') ? 'primary' : ''} onClick={() => answer(p, o.optionId)}>{o.name}</button>)}
            </div>
          </div>
        ))}
        {asks.map((a) => <QuestionCard key={a.requestId} questions={a.questions} footer={a.footer} onSubmit={(v) => reply(a, v)} onDismiss={() => reply(a, null)} />)}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
        <MentionTextarea value={input} onChange={setInput} onSubmit={send} disabled={status !== 'ready'} placeholder="Tell the agent what to do…  (Enter to send, @ to attach files)"
          sessionKey={`${folder}|${activeSessionId ?? ''}`} loadFiles={() => window.api.code.listFiles(idRef.current!)} />
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
