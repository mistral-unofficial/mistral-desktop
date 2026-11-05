import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkCallback, WorkChat, WorkChatSummary, WorkEvent, WorkMessage } from '@shared/types'
import { Collapsible, Markdown, PlainText } from '../components'
import type { SettingsSection } from '../settingsSections'
import { SidebarPortal } from '../sidebar'

/**
 * Le Chat "Work" chats through the website's internal API: the same history as chat.mistral.ai/work. The API is
 * undocumented, so errors are shown plainly instead of being hidden.
 */
export function WorkView({ active }: { active: boolean; goSettings: (section?: SettingsSection) => void }) {
  const [signedIn, setSignedIn] = useState<boolean>()
  const [list, setList] = useState<WorkChatSummary[]>([])
  const [cursor, setCursor] = useState<string>()
  const [chat, setChat] = useState<WorkChat>()
  const [input, setInput] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const reqRef = useRef<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const streaming = requestId !== null

  const refresh = useCallback(async (): Promise<void> => {
    const st = await window.api.work.status()
    setSignedIn(st.signedIn)
    if (!st.signedIn) return
    const r = await window.api.work.list()
    if (r.ok) {
      setList(r.chats)
      setCursor(r.nextCursor)
      setError('')
    } else setError(r.error)
  }, [])

  // Re-read whenever the tab is shown: the chats may have changed in the browser.
  useEffect(() => {
    if (active && !streaming) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(
    () =>
      window.api.work.onEvent((rid: string, e: WorkEvent) => {
        if (rid !== reqRef.current) return
        if (e.type === 'state') {
          setChat(e.chat)
        } else if (e.type === 'error') setError(e.message)
        else {
          reqRef.current = null
          setRequestId(null)
          void window.api.work.list().then((r) => r.ok && (setList(r.chats), setCursor(r.nextCursor)))
        }
      }),
    []
  )

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [chat?.messages])

  const signIn = async (): Promise<void> => setSignedIn((await window.api.work.signIn()).signedIn)
  const more = async (): Promise<void> => {
    if (!cursor) return
    const r = await window.api.work.list(cursor)
    if (r.ok) (setList((l) => [...l, ...r.chats.filter((c) => !l.some((x) => x.id === c.id))]), setCursor(r.nextCursor))
    else setError(r.error)
  }
  const open = async (id: string): Promise<void> => {
    setLoading(true)
    setError('')
    const r = await window.api.work.get(id)
    setLoading(false)
    if (r.ok) setChat(r.chat)
    else setError(r.error)
  }
  const remove = async (id: string): Promise<void> => {
    setConfirmDelete(undefined)
    const err = await window.api.work.remove(id)
    if (err) return setError(err)
    if (chat?.id === id) setChat(undefined)
    setList((l) => l.filter((c) => c.id !== id))
  }
  const send = (): void => {
    const text = input.trim()
    if (!text || streaming) return
    const rid = crypto.randomUUID()
    setInput('')
    setError('')
    // Show the message right away; the server's own copy replaces it with the first update.
    const pending: WorkMessage = { id: `local-${rid}`, role: 'user', text, reasoning: '', status: 'success' }
    setChat((c) => ({ id: c?.id ?? '', title: c?.title ?? 'New chat', messages: [...(c?.messages ?? []), pending] }))
    reqRef.current = rid
    setRequestId(rid)
    void window.api.work.send({ requestId: rid, chatId: chat?.id || undefined, text })
  }

  // The agent can pause its turn to ask something; the answer continues the same assistant message.
  const lastMsg = chat?.messages.at(-1)
  const pending = !streaming && lastMsg?.role === 'assistant' ? lastMsg.callbacks?.find((c) => c.status === 'pending') : undefined
  const pendingQuestion = pending?.name === 'ask_user_question' && pending.questions.length ? pending : undefined
  const answer = (values: string[]): void => {
    if (!chat?.id || !lastMsg || !pendingQuestion || streaming) return
    const rid = crypto.randomUUID()
    setError('')
    reqRef.current = rid
    setRequestId(rid)
    void window.api.work.answer({ requestId: rid, chatId: chat.id, messageId: lastMsg.id, callbackId: pendingQuestion.id, values })
  }

  return (
    <div className="split">
      <SidebarPortal tab="work">
        <div className="sidenav">
          <button className="navbtn" disabled={streaming} onClick={() => { setChat(undefined); setError('') }}><span aria-hidden="true">＋</span> New</button>
        </div>
        {signedIn && (
          <ul className="convlist">
            {list.map((c) => (
              <li key={c.id} className={c.id === chat?.id ? 'active' : ''}>
                <button className="convbtn" disabled={streaming} onClick={() => void open(c.id)} title={c.title}>{c.title}</button>
                {confirmDelete === c.id ? (
                  <>
                    <button className="iconbtn danger" aria-label={`Confirm delete ${c.title}`} onClick={() => void remove(c.id)}>Delete?</button>
                    <button className="iconbtn" aria-label="Keep" onClick={() => setConfirmDelete(undefined)}>✕</button>
                  </>
                ) : (
                  <button className="iconbtn" aria-label={`Delete ${c.title}`} disabled={streaming} onClick={() => setConfirmDelete(c.id)}>✕</button>
                )}
              </li>
            ))}
            {cursor && <li><button className="convbtn muted" onClick={() => void more()}>Load more…</button></li>}
          </ul>
        )}
      </SidebarPortal>
      <div className="content">
        <header className="bar">
          <strong>{chat?.title ?? 'Work'}</strong>
          <span className="muted">Synced with chat.mistral.ai/work (unofficial API)</span>
        </header>
        {signedIn === false && (
          <div className="banner">Work uses your Le Chat web sign-in. <button className="linklike" onClick={() => void signIn()}>Sign in to Le Chat</button></div>
        )}
        {error && <div className="banner error" role="alert">{error}</div>}
        <div className="messages" aria-live="polite">
          {loading && <div className="muted">Loading…</div>}
          {!loading && !chat?.messages.length && <div className="empty">Start a Work chat. It shows up in chat.mistral.ai/work too.</div>}
          {chat?.messages.map((m) => <WorkItem key={m.id} m={m} />)}
          {streaming && <div className="muted thinking">…</div>}
          <div ref={bottom} />
        </div>
        {pending && !pendingQuestion && (
          <div className="banner">The agent is waiting for input this app cannot show ({pending.name || 'unknown'}). Continue this chat at chat.mistral.ai/work.</div>
        )}
        {pendingQuestion ? (
          <WorkQuestions key={pendingQuestion.id} cb={pendingQuestion} onSubmit={answer} />
        ) : (
          <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
            <textarea
              value={input}
              disabled={signedIn === false}
              placeholder="Message Work…  (Enter to send, Shift+Enter for a new line)"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
              rows={2}
            />
            {streaming
              ? <button type="button" className="danger" onClick={() => void window.api.work.cancel(reqRef.current!)}>Stop</button>
              : <button type="submit" className="primary" disabled={!input.trim() || signedIn === false}>Send</button>}
          </form>
        )}
      </div>
    </div>
  )
}

function WorkItem({ m }: { m: WorkMessage }) {
  if (m.role === 'user') return <div className="msg user"><PlainText text={m.text} /></div>
  return (
    <div className="msg assistant">
      {m.reasoning && <Collapsible summary="Reasoning"><div className="muted"><PlainText text={m.reasoning} /></div></Collapsible>}
      {m.callbacks?.filter((c) => c.status !== 'pending' && c.answers?.length).map((c) => (
        <div key={c.id} className="muted workqa">
          {c.questions.map((q, i) => <div key={i}>{q.question} <strong>{c.answers?.[i]}</strong></div>)}
        </div>
      ))}
      {m.text ? <Markdown text={m.text} /> : m.status === 'in-progress' ? <span className="muted">…</span> : null}
      {m.status === 'error' && <div className="warnline">The answer failed.</div>}
    </div>
  )
}

/** The agent's question, shown in place of the composer. Options are suggestions; any text is a valid answer. */
function WorkQuestions({ cb, onSubmit }: { cb: WorkCallback; onSubmit: (values: string[]) => void }) {
  const [values, setValues] = useState<string[]>(() => cb.questions.map(() => ''))
  const single = cb.questions.length === 1
  const set = (i: number, v: string): void => setValues((a) => a.map((x, j) => (j === i ? v : x)))
  const ready = values.every((v) => v.trim())
  return (
    <div className="workq" role="group" aria-label="The agent has a question">
      {cb.questions.map((q, i) => (
        <div key={i} className="workq-item">
          <div className="workq-text">{q.question}</div>
          <div className="workq-options">
            {q.options.map((o, n) => (
              <button key={o} type="button" className={values[i] === o ? 'workq-opt selected' : 'workq-opt'} onClick={() => (single ? onSubmit([o]) : set(i, o))}>
                <span className="workq-n">{n + 1}</span>{o}
              </button>
            ))}
            <input
              className="workq-free"
              value={q.options.includes(values[i] ?? '') ? '' : values[i]}
              placeholder="Or type your own answer…"
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && (single ? values[i]?.trim() : ready)) { e.preventDefault(); onSubmit(values) } }}
            />
          </div>
        </div>
      ))}
      <div className="workq-foot">
        <button type="button" className="primary" disabled={!ready} onClick={() => onSubmit(values)}>{single ? 'Answer' : 'Submit answers'}</button>
      </div>
    </div>
  )
}
