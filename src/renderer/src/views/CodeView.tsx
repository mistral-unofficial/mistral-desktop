import { useEffect, useRef, useState } from 'react'
import type { CodeEvent, CodeMode, CodeStartResult, PermissionOption } from '@shared/types'
import { applyCodeUpdate, type CodeItem, type CodeState } from '../codeState'
import { Collapsible, Diff, RichText } from '../components'

type Status = 'idle' | 'starting' | 'ready' | 'needs-auth' | 'error' | 'exited'
interface Perm { requestId: string; title: string; options: PermissionOption[] }

export function CodeView({ goSettings, active }: { goSettings: () => void; active: boolean }) {
  const [folder, setFolder] = useState<string>()
  const [recent, setRecent] = useState<string[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [auth, setAuth] = useState<{ id: string; methods: { id: string; name: string }[] }>()
  const [modes, setModes] = useState<CodeMode[]>([])
  const [mode, setMode] = useState('')
  const [state, setState] = useState<CodeState>({ items: [] })
  const [busy, setBusy] = useState(false)
  const [perms, setPerms] = useState<Perm[]>([])
  const [input, setInput] = useState('')
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
        if (e.stopReason !== 'end_turn') setState((s) => ({ ...s, items: [...s.items, { kind: 'info', text: `Turn ended: ${e.stopReason}` }] }))
        break
      case 'error': setBusy(false); setState((s) => ({ ...s, items: [...s.items, { kind: 'error', text: e.message }] })); break
      case 'exit': setBusy(false); setStatus('exited'); setMessage(`The Vibe process exited (code ${e.code ?? 'unknown'}). Choose the folder again to restart.`); break
    }
  }

  useEffect(() => {
    if (active) void window.api.settings.get().then((s) => setRecent(s.recentFolders))
  }, [active])

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
      setStatus('ready'); setModes(r.modes); setMode(r.currentMode); setAuth(undefined); setMessage('')
      for (const e of buffered.current.get(r.id) ?? []) handle(e)
      buffered.current.delete(r.id)
      void window.api.settings.get().then((s) => setRecent(s.recentFolders))
    } else if (r.status === 'needs-auth') {
      idRef.current = r.id
      setStatus('needs-auth'); setMessage(r.message); setAuth({ id: r.id, methods: r.authMethods })
    } else { setStatus('error'); setMessage(r.message) }
  }

  const begin = async (dir: string): Promise<void> => {
    if (idRef.current) void window.api.code.stop(idRef.current)
    idRef.current = undefined
    setFolder(dir); setStatus('starting'); setState({ items: [] }); setPerms([]); setBusy(false); setMessage('')
    adopt(await window.api.code.start(dir))
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
  const answer = (p: Perm, optionId: string | null): void => {
    setPerms((ps) => ps.filter((x) => x.requestId !== p.requestId))
    void window.api.code.respondPermission(idRef.current!, p.requestId, optionId)
  }

  if (!folder || status === 'idle') {
    return (
      <div className="center">
        <h2>Code</h2>
        <p className="muted">Pick a project folder. Mistral Vibe runs inside it and can read and edit files there.</p>
        <button className="primary" onClick={() => void choose()}>Choose folder…</button>
        {!!recent.length && (<><h3>Recent</h3><ul className="recent">{recent.map((r) => <li key={r}><button className="linklike" onClick={() => void begin(r)}>{r}</button></li>)}</ul></>)}
      </div>
    )
  }

  return (
    <div className="content">
      <header className="bar">
        <span className="folder" title={folder}>📁 {folder}</span>
        <button onClick={() => void choose()}>Change…</button>
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
  )
}

function CodeRow({ item }: { item: CodeItem }) {
  switch (item.kind) {
    case 'user': return <div className="msg user"><RichText text={item.text} /></div>
    case 'agent': return <div className="msg assistant"><RichText text={item.text} /></div>
    case 'thought': return <Collapsible summary="Thinking"><div className="muted"><RichText text={item.text} /></div></Collapsible>
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
