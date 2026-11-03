import { useState } from 'react'
import type { CodeWorkspace } from '@shared/types'

export const folderName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

const SHOWN = 5

interface Props {
  workspaces: CodeWorkspace[]
  activeFolder?: string
  activeSessionId?: string
  /** 'side' is the compact sidebar list, 'cards' the larger one on the empty main screen. */
  variant: 'side' | 'cards'
  onNewSession: (path: string) => void
  onOpen: (path: string, sessionId: string) => void
}

export function WorkspaceList({ workspaces, activeFolder, activeSessionId, variant, onNewSession, onOpen }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const flip = (set: Set<string>, setter: (s: Set<string>) => void, key: string): void => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    setter(next)
  }
  return (
    <div className={`wslist ${variant}`}>
      {workspaces.map((w) => {
        const open = !collapsed.has(w.path)
        const all = expanded.has(w.path)
        const shown = all ? w.sessions : w.sessions.slice(0, SHOWN)
        return (
          <section key={w.path} className={w.path === activeFolder ? 'ws active' : 'ws'}>
            <header className="wshead">
              <button className="wsname" aria-expanded={open} title={w.path} onClick={() => flip(collapsed, setCollapsed, w.path)}>
                <span className="wsname-text">{folderName(w.path)}</span>
                <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              <button className="iconbtn wsnew" aria-label={`New session in ${folderName(w.path)}`} title="New session" onClick={() => onNewSession(w.path)}>＋</button>
            </header>
            {variant === 'cards' && <div className="muted wspath">{w.path}</div>}
            {open && (
              <ul className="wssessions">
                {shown.map((s) => (
                  <li key={s.sessionId}>
                    <button className={w.path === activeFolder && s.sessionId === activeSessionId ? 'wssession current' : 'wssession'} title={s.title} onClick={() => onOpen(w.path, s.sessionId)}>
                      <span className="wssession-title">{s.title}</span>
                      {variant === 'cards' && s.updatedAt && <span className="muted">{new Date(s.updatedAt).toLocaleDateString()}</span>}
                    </button>
                  </li>
                ))}
                {!w.sessions.length && <li className="muted wsempty">No sessions yet</li>}
                {w.sessions.length > SHOWN && (
                  <li><button className="linklike wsmore" onClick={() => flip(expanded, setExpanded, w.path)}>{all ? 'Show fewer' : `Show all ${w.sessions.length}`}</button></li>
                )}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
