import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CodeEvent, CodeMode, CodeStartResult } from '../../shared/types'
import { toAcpServers } from '../mcp/host'
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
    private emit: (id: string, e: CodeEvent) => void
  ) {}

  async start(cwd: string): Promise<CodeStartResult> {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { status: 'error', message: `Not a folder: ${cwd}` }
    const s = this.settings.get()
    const id = randomUUID()
    const client = new AcpClient()
    const sess: Session = { client, cwd, authMethods: [], perms: new Map(), stderrTail: '', busy: false }
    this.sessions.set(id, sess)

    client.on('update', (p: { update?: { sessionUpdate: string } }) => {
      if (p?.update) this.emit(id, { type: 'update', update: p.update as CodeEvent extends { update: infer U } ? U : never })
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
      const res = await sess.client.newSession(sess.cwd, toAcpServers(this.settings.get().mcpServers))
      sess.acpSessionId = res.sessionId
      const modes: CodeMode[] = res.modes?.availableModes ?? []
      return { status: 'ready', id, modes, currentMode: res.modes?.currentModeId ?? '' }
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
