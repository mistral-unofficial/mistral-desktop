import type { CodeSessionInfo, CodeWorkspace } from '@shared/types'

export interface PendingSession {
  path: string
  session: CodeSessionInfo
}

/**
 * The workspace list as shown in the sidebar: what Vibe lists, plus sessions the user has just started that Vibe
 * has not listed yet (newest first, in their folder; a folder that is not listed yet is added).
 */
export function mergePending(workspaces: CodeWorkspace[], pending: PendingSession[]): CodeWorkspace[] {
  const listed = new Set(workspaces.flatMap((w) => w.sessions.map((s) => s.sessionId)))
  const extra = pending.filter((p) => !listed.has(p.session.sessionId))
  const out = workspaces.map((w) => ({ ...w, sessions: [...extra.filter((p) => p.path === w.path).map((p) => p.session), ...w.sessions] }))
  for (const p of extra) if (!out.some((w) => w.path === p.path)) out.unshift({ path: p.path, sessions: extra.filter((q) => q.path === p.path).map((q) => q.session) })
  return out
}
