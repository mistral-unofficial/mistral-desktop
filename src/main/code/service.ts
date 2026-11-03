import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodeEvent, CodeMode, CodeResumeResult, CodeSessionInfo, CodeStartResult } from '../../shared/types'
import type { SettingsStore } from '../settings'
import { AcpClient, AcpError, type AcpAuthMethod } from './acp-client'

interface Session {
  client: AcpClient
  cwd: string
  acpSessionId?: string
  authMethods: AcpAuthMethod[]
  perms: Map<string, (optionId: string | null) => void>
  stderrTail: string
  busy: boolean
  canList: boolean
  canLoad: boolean
  canClose: boolean
  /** While a stored session loads, its replayed updates are collected here instead of being emitted. */
  replay: (Record<string, unknown> & { sessionUpdate: string })[] | null
}

export const VIBE_INSTALL_HINT = 'Vibe is not installed. Install it with `uv tool install mistral-vibe` (or `pip install mistral-vibe`), or set its path in Settings.'

export function resolveVibeCommand(configured: string): string {
  if (configured.trim()) return configured.trim()
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp')
  return existsSync(local) ? local : 'vibe-acp'
}

export class CodeService {
  private sessions = new Map<string, Session>()
  constructor(
    private settings: SettingsStore,
    private emit: (id: string, e: CodeEvent) => void,
    /** MCP servers (in ACP shape) to give each session: manual, remote and extension servers. */
    private getServers: () => Promise<unknown[]> = async () => []
  ) {}

  async start(cwd: string): Promise<CodeStartResult> {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { status: 'error', message: `Not a folder: ${cwd}` }
    const s = this.settings.get()
    const id = randomUUID()
    const client = new AcpClient()
    const sess: Session = { client, cwd, authMethods: [], perms: new Map(), stderrTail: '', busy: false, canList: false, canLoad: false, canClose: false, replay: null }
    this.sessions.set(id, sess)

    client.on('update', (p: { update?: Record<string, unknown> & { sessionUpdate: string } }) => {
      if (!p?.update) return
      if (sess.replay) sess.replay.push(p.update)
      else this.emit(id, { type: 'update', update: p.update })
    })
    client.on('permission', (req: { toolCall: Record<string, unknown> & { title?: string }; options: { optionId: string; name: string; kind: string }[] }, respond: (o: string | null) => void) => {
      const requestId = randomUUID()
      sess.perms.set(requestId, respond)
      this.emit(id, { type: 'permission', requestId, title: String(req.toolCall?.title ?? 'Permission requested'), options: req.options ?? [], toolCall: req.toolCall ?? {} })
    })
    client.on('stderr', (t: string) => (sess.stderrTail = (sess.stderrTail + t).slice(-2000)))
    client.on('exit', (code: number | null) => this.emit(id, { type: 'exit', code }))

    const env: NodeJS.ProcessEnv = {}
    const key = this.settings.getApiKey()
    if (key) env.MISTRAL_API_KEY = key
    if (s.vibeHome) env.VIBE_HOME = s.vibeHome
    const cmd = resolveVibeCommand(s.vibePath)
    client.start(cmd, [], { cwd, env })

    try {
      const init = await client.initialize()
      sess.authMethods = init.authMethods ?? []
      const caps = init.agentCapabilities
      sess.canLoad = !!caps?.loadSession
      sess.canList = !!caps?.sessionCapabilities?.list
      sess.canClose = !!caps?.sessionCapabilities?.close
    } catch (e) {
      this.drop(id)
      const notFound = /ENOENT/.test((e as Error).message)
      return { status: 'error', message: notFound ? VIBE_INSTALL_HINT : (e as Error).message }
    }
    this.remember(cwd)
    return this.openSession(id, sess)
  }

  private async openSession(id: string, sess: Session): Promise<CodeStartResult> {
    try {
      const res = await sess.client.newSession(sess.cwd, await this.getServers())
      sess.acpSessionId = res.sessionId
      const modes: CodeMode[] = res.modes?.availableModes ?? []
      return { status: 'ready', id, modes, currentMode: res.modes?.currentModeId ?? '', canResume: sess.canList && sess.canLoad }
    } catch (e) {
      const msg = (e as Error).message
      if (sess.authMethods.length && e instanceof AcpError) {
        return { status: 'needs-auth', id, authMethods: sess.authMethods, message: msg }
      }
      this.drop(id)
      return { status: 'error', message: sess.stderrTail && !msg ? sess.stderrTail : msg }
    }
  }

  async authenticate(id: string, methodId: string): Promise<CodeStartResult> {
    const sess = this.sessions.get(id)
    if (!sess) return { status: 'error', message: 'Session not found' }
    try {
      await sess.client.authenticate(methodId)
    } catch (e) {
      return { status: 'needs-auth', id, authMethods: sess.authMethods, message: `Sign-in failed: ${(e as Error).message}` }
    }
    return this.openSession(id, sess)
  }

  private remember(cwd: string): void {
    const recent = [cwd, ...this.settings.get().recentFolders.filter((f) => f !== cwd)].slice(0, 8)
    this.settings.update({ recentFolders: recent })
  }

  /** Stored sessions for this session's folder, newest first (excluding the one currently open). */
  async listSessions(id: string): Promise<CodeSessionInfo[]> {
    const sess = this.sessions.get(id)
    if (!sess?.canList) return []
    const out: CodeSessionInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const r = await sess.client.listSessions(sess.cwd, cursor)
      for (const s of r.sessions ?? []) if (s.sessionId !== sess.acpSessionId) out.push({ sessionId: s.sessionId, title: s.title?.trim() || 'Untitled session', updatedAt: s.updatedAt ?? null })
      cursor = r.nextCursor ?? undefined
      if (!cursor) break
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  /** Switch this connection to a stored session. The conversation is returned as the replayed update stream. */
  async resume(id: string, sessionId: string): Promise<CodeResumeResult> {
    const sess = this.sessions.get(id)
    if (!sess) return { status: 'error', message: 'Session not found' }
    if (!sess.canLoad) return { status: 'error', message: 'This version of Vibe cannot resume sessions' }
    if (sess.busy) return { status: 'error', message: 'Wait for the current turn to finish first' }
    const previous = sess.acpSessionId
    sess.replay = []
    try {
      const res = await sess.client.loadSession(sessionId, sess.cwd, await this.getServers())
      const history = sess.replay
      sess.acpSessionId = sessionId
      if (previous && previous !== sessionId && sess.canClose) void sess.client.closeSession(previous).catch(() => undefined)
      return { status: 'ready', modes: res.modes?.availableModes ?? [], currentMode: res.modes?.currentModeId ?? '', history }
    } catch (e) {
      return { status: 'error', message: (e as Error).message }
    } finally {
      sess.replay = null
    }
  }

  prompt(id: string, text: string): void {
    const sess = this.sessions.get(id)
    if (!sess?.acpSessionId) return this.emit(id, { type: 'error', message: 'Session is not ready' })
    if (sess.busy) return this.emit(id, { type: 'error', message: 'A turn is already running' })
    sess.busy = true
    sess.client
      .prompt(sess.acpSessionId, text)
      .then((r) => this.emit(id, { type: 'turn-end', stopReason: r.stopReason }))
      .catch((e: Error) => this.emit(id, { type: 'error', message: e.message }))
      .finally(() => {
        sess.busy = false
        for (const respond of sess.perms.values()) respond(null) // a finished turn cannot still await permission
        sess.perms.clear()
      })
  }

  cancel(id: string): void {
    const sess = this.sessions.get(id)
    if (!sess?.acpSessionId) return
    for (const respond of sess.perms.values()) respond(null)
    sess.perms.clear()
    sess.client.cancel(sess.acpSessionId)
  }

  async setMode(id: string, modeId: string): Promise<void> {
    const sess = this.sessions.get(id)
    if (sess?.acpSessionId) await sess.client.setMode(sess.acpSessionId, modeId)
  }

  respondPermission(id: string, requestId: string, optionId: string | null): void {
    const sess = this.sessions.get(id)
    const respond = sess?.perms.get(requestId)
    if (!respond) return
    sess?.perms.delete(requestId)
    respond(optionId)
  }

  private drop(id: string): void {
    const sess = this.sessions.get(id)
    this.sessions.delete(id)
    sess?.client.kill()
  }

  stop(id: string): void {
    this.drop(id)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.drop(id)
  }
}
