import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { BrowserSignInResult, CodeEvent, CodeWorkspace, CodeMode, CodeResumeResult, CodeSessionInfo, CodeStartResult } from '../../shared/types'
import type { SettingsStore } from '../settings'
import { readVibeApiKey } from '../vibe-credentials'
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

/** Directories where Vibe usually ends up. GUI apps do not inherit the shell PATH, so Homebrew etc. are not on it. */
export function vibeSearchDirs(): string[] {
  if (process.platform === 'win32') return [join(homedir(), '.local', 'bin')]
  return [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']
}

/** PATH for spawned agents: the inherited one plus the usual tool directories. */
export function augmentedPath(base: string | undefined = process.env.PATH): string {
  const parts = (base ?? '').split(delimiter).filter(Boolean)
  for (const d of [...vibeSearchDirs(), '/opt/homebrew/sbin', '/usr/local/sbin']) if (!parts.includes(d)) parts.push(d)
  return parts.join(delimiter)
}

export function resolveVibeCommand(configured: string): string {
  if (configured.trim()) return configured.trim()
  const exe = process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp'
  for (const dir of vibeSearchDirs()) {
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  return 'vibe-acp'
}

/** All stored sessions Vibe has for a folder, newest first, optionally leaving one out. */
async function collectSessions(client: AcpClient, cwd: string, exclude?: string): Promise<CodeSessionInfo[]> {
  const out: CodeSessionInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const r = await client.listSessions(cwd, cursor)
    for (const s of r.sessions ?? []) if (s.sessionId !== exclude) out.push({ sessionId: s.sessionId, title: s.title?.trim() || 'Untitled session', updatedAt: s.updatedAt ?? null })
    cursor = r.nextCursor ?? undefined
    if (!cursor) break
  }
  return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
}

/** The app's own sign-in window, so a login can leave a web session behind. */
export interface WebAuthWindows {
  open(url: string): { closed: Promise<void>; close(): void }
}

export class CodeService {
  private sessions = new Map<string, Session>()
  constructor(
    private settings: SettingsStore,
    private emit: (id: string, e: CodeEvent) => void,
    /** MCP servers (in ACP shape) to give each session: manual, remote and extension servers. */
    private getServers: () => Promise<unknown[]> = async () => [],
    /** Reads the key Vibe stored after sign-in. Replaceable so tests never touch the real keychain. */
    private readKey: (vibeHome: string) => Promise<string | undefined> = readVibeApiKey
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

    const env: NodeJS.ProcessEnv = { PATH: augmentedPath() }
    const key = await this.settings.getApiKey()
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
      return { status: 'ready', id, modes, currentMode: res.modes?.currentModeId ?? '', canResume: sess.canList && sess.canLoad, sessionId: res.sessionId }
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

  /**
   * "Sign in with Mistral" for the whole app. Vibe runs its browser sign-in in a throwaway agent process and
   * mints an API key (keychain or ~/.vibe/.env), which is imported into this app's own key store so Chat and
   * Code both use it.
   *
   * With `web`, the sign-in page is shown in the app's own window (Vibe's "delegated" mode), so the same login
   * also leaves a chat.mistral.ai session in the app's web partition. Without it, or when Vibe does not offer the
   * delegated mode, Vibe opens the system browser as before.
   */
  async signInWithBrowser(web?: WebAuthWindows): Promise<BrowserSignInResult> {
    const s = this.settings.get()
    const client = new AcpClient()
    let stderr = ''
    let win: { closed: Promise<void>; close(): void } | undefined
    client.on('stderr', (t: string) => (stderr = (stderr + t).slice(-2000)))
    // No MISTRAL_API_KEY here, otherwise Vibe sees a key already and offers no sign-in.
    client.start(resolveVibeCommand(s.vibePath), [], { cwd: homedir(), env: { PATH: augmentedPath(), ...(s.vibeHome ? { VIBE_HOME: s.vibeHome } : {}), MISTRAL_API_KEY: '' } })
    try {
      const init = await client.initialize({ delegatedBrowserAuth: !!web })
      const methods = init.authMethods ?? []
      const delegated = web ? methods.find((m) => m.id === 'browser-auth-delegated') : undefined
      if (web && delegated) {
        const started = (await client.authenticate(delegated.id, { action: 'start' }))?._meta?.['browser-auth-delegated']
        const url = started?.signInUrl
        const attemptId = started?.attemptId
        if (typeof url !== 'string' || typeof attemptId !== 'string') throw new Error('Vibe did not return a sign-in page')
        win = web.open(url)
        const done = client.authenticate(delegated.id, { action: 'complete', attemptId }).then(() => 'ok' as const)
        done.catch(() => undefined)
        let outcome = await Promise.race([done, win.closed.then(() => 'closed' as const)])
        if (outcome === 'closed') {
          // Closing the window right after finishing is fine: give the exchange a moment to land.
          outcome = await Promise.race([done, new Promise<'closed'>((r) => setTimeout(() => r('closed'), 5000))]).catch(() => 'closed' as const)
        }
        if (outcome !== 'ok') return { ok: false, error: 'Sign-in was cancelled before it finished.' }
      } else {
        const method = methods.find((m) => m.id === 'browser-auth') ?? methods[0]
        if (method) await client.authenticate(method.id)
      }
    } catch (e) {
      const msg = (e as Error).message
      return { ok: false, error: /ENOENT/.test(msg) ? VIBE_INSTALL_HINT : stderr && !msg ? stderr : msg }
    } finally {
      // Whatever happened, the sign-in window must not be left open.
      win?.close()
      client.kill()
    }
    const key = await this.readKey(s.vibeHome)
    if (!key) return { ok: false, error: 'Signed in, but the key Vibe created could not be read from the keychain or ~/.vibe/.env. Paste an API key instead.' }
    await this.settings.setApiKey(key)
    return { ok: true }
  }

  private remember(cwd: string): void {
    const recent = [cwd, ...this.settings.get().recentFolders.filter((f) => f !== cwd)].slice(0, 20)
    this.settings.update({ recentFolders: recent })
  }

  /** Stored sessions for this session's folder, newest first (excluding the one currently open). */
  async listSessions(id: string): Promise<CodeSessionInfo[]> {
    const sess = this.sessions.get(id)
    if (!sess?.canList) return []
    return collectSessions(sess.client, sess.cwd, sess.acpSessionId)
  }

  private workspacesInflight?: Promise<CodeWorkspace[]>

  /**
   * Recently opened folders with their stored sessions. Vibe only lists sessions through a running agent, so
   * this starts one short-lived process (not tied to any folder), asks it per folder and stops it again.
   */
  listWorkspaces(): Promise<CodeWorkspace[]> {
    this.workspacesInflight ??= this.readWorkspaces().finally(() => (this.workspacesInflight = undefined))
    return this.workspacesInflight
  }

  /** Runs `fn` against a short-lived agent process that is not tied to any folder or session. */
  private async withTempAgent<T>(fn: (client: AcpClient, caps: { canList: boolean }) => Promise<T>, fallback: T): Promise<T> {
    const s = this.settings.get()
    const client = new AcpClient()
    client.on('stderr', () => undefined)
    client.start(resolveVibeCommand(s.vibePath), [], { cwd: homedir(), env: { PATH: augmentedPath(), ...(s.vibeHome ? { VIBE_HOME: s.vibeHome } : {}) } })
    try {
      const init = await client.initialize()
      return await fn(client, { canList: !!init.agentCapabilities?.sessionCapabilities?.list })
    } catch (e) {
      if (fallback === undefined) throw e
      return fallback
    } finally {
      client.kill()
    }
  }

  private async readWorkspaces(): Promise<CodeWorkspace[]> {
    const folders = this.settings.get().recentFolders.filter((f) => existsSync(f))
    const bare = folders.map((path) => ({ path, sessions: [] as CodeSessionInfo[] }))
    if (!folders.length) return bare
    return this.withTempAgent(async (client, { canList }) => {
      if (!canList) return bare
      const out: CodeWorkspace[] = []
      for (const path of folders) out.push({ path, sessions: await collectSessions(client, path).catch(() => []) })
      return out
    }, bare)
  }

  private liveSession(sessionId: string): [string, Session] | undefined {
    return [...this.sessions.entries()].find(([, s]) => s.acpSessionId === sessionId)
  }

  /** Renames a stored session. Goes through the open agent when it holds the session, so it does not overwrite the new title later. */
  async renameSession(sessionId: string, title: string): Promise<string | undefined> {
    const t = title.trim()
    if (!t) return 'The name cannot be empty'
    try {
      const live = this.liveSession(sessionId)
      if (live) await live[1].client.renameSession(sessionId, t)
      else await this.withTempAgent((c) => c.renameSession(sessionId, t), undefined)
      return undefined
    } catch (e) {
      return (e as Error).message
    }
  }

  /** Deletes a stored session. If it is the open one, its agent is closed and stopped as well. */
  async deleteSession(sessionId: string): Promise<string | undefined> {
    try {
      const live = this.liveSession(sessionId)
      if (live) {
        try {
          await live[1].client.deleteSession(sessionId)
        } finally {
          this.drop(live[0])
        }
      } else await this.withTempAgent((c) => c.deleteSession(sessionId), undefined)
      return undefined
    } catch (e) {
      return (e as Error).message
    }
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
