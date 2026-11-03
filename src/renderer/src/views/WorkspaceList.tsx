import { useState } from 'react'
import type { CodeSessionInfo, CodeWorkspace } from '@shared/types'
import { ContextMenu } from '../ContextMenu'

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
  onRename: (path: string, session: CodeSessionInfo, title: string) => void
  onDelete: (path: string, session: CodeSessionInfo) => void
  onNewWorktree: (path: string) => void
  onRemoveWorktree: (workspace: CodeWorkspace) => void
}

export function WorkspaceList({ workspaces, activeFolder, activeSessionId, variant, onNewSession, onOpen, onRename, onDelete, onNewWorktree, onRemoveWorktree }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; session: CodeSessionInfo }>()
  const [wsMenu, setWsMenu] = useState<{ x: number; y: number; ws: CodeWorkspace }>()
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const commit = (path: string, session: CodeSessionInfo): void => {
    const title = editing?.text.trim()
    setEditing(undefined)
    if (title && title !== session.title) onRename(path, session, title)
  }
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
            <header className="wshead" onContextMenu={(e) => { e.preventDefault(); setWsMenu({ x: e.clientX, y: e.clientY, ws: w }) }}>
              <button className="wsname" aria-expanded={open} title={w.worktree ? `${w.path}\nWorktree of ${w.worktree.mainRepo}` : w.path} onClick={() => flip(collapsed, setCollapsed, w.path)}>
                <span className="wsname-text">{w.worktree ? folderName(w.worktree.mainRepo) : folderName(w.path)}</span>
                {w.worktree && <span className="wtbadge" title="Git worktree"><span aria-hidden="true">⎇</span> {w.worktree.branch}</span>}
                <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
              <button className="iconbtn wsnew" aria-label={`New session in ${folderName(w.path)}`} title="New session" onClick={() => onNewSession(w.path)}>＋</button>
            </header>
            {variant === 'cards' && <div className="muted wspath">{w.path}</div>}
            {open && (
              <ul className="wssessions">
                {shown.map((s) => (
                  <li key={s.sessionId}>
                    {editing?.id === s.sessionId ? (
                      <input
                        className="wsrename"
                        autoFocus
                        aria-label="Session name"
                        value={editing.text}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditing({ id: s.sessionId, text: e.target.value })}
                        onBlur={() => commit(w.path, s)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit(w.path, s)
                          if (e.key === 'Escape') setEditing(undefined)
                        }}
                      />
                    ) : (
                      <button
                        className={w.path === activeFolder && s.sessionId === activeSessionId ? 'wssession current' : 'wssession'}
                        title={s.title}
                        onClick={() => onOpen(w.path, s.sessionId)}
                        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, path: w.path, session: s }) }}
                      >
                        <span className="wssession-title">{s.title}</span>
                        {variant === 'cards' && s.updatedAt && <span className="muted">{new Date(s.updatedAt).toLocaleDateString()}</span>}
                      </button>
                    )}
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
      {wsMenu && (
        <ContextMenu
          x={wsMenu.x}
          y={wsMenu.y}
          onClose={() => setWsMenu(undefined)}
          items={[
            { label: 'New session', onSelect: () => onNewSession(wsMenu.ws.path) },
            { label: 'New session in a new worktree…', onSelect: () => onNewWorktree(wsMenu.ws.path) },
            ...(wsMenu.ws.worktree ? [{ label: 'Remove worktree…', danger: true, onSelect: () => onRemoveWorktree(wsMenu.ws) }] : [])
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            { label: 'Rename', onSelect: () => setEditing({ id: menu.session.sessionId, text: menu.session.title }) },
            { label: 'Delete', danger: true, onSelect: () => onDelete(menu.path, menu.session) }
          ]}
        />
      )}
    </div>
  )
}
