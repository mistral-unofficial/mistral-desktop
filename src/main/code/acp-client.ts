import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
}

export interface AcpCapabilities {
  loadSession?: boolean
  sessionCapabilities?: { list?: unknown; close?: unknown; fork?: unknown }
}

export interface AcpSessionInfo {
  sessionId: string
  cwd?: string
  title?: string | null
  updatedAt?: string | null
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCall: Record<string, unknown> & { title?: string }
  options: { optionId: string; name: string; kind: string }[]
}

export interface AcpQuestion {
  /** Form field name; the answer is returned under this key. */
  key: string
  header?: string
  question: string
  options: string[]
  multi: boolean
}
export interface AcpElicitation {
  sessionId?: string
  message?: string
  footer?: string
  questions: AcpQuestion[]
}
export type AcpElicitationAnswers = Record<string, string | string[]>

/**
 * Reads a form-mode `elicitation/create` request (what Vibe's ask_user_question becomes over ACP). Returns undefined
 * for anything this client cannot show: URL mode, or fields other than single/multi choice or plain text.
 */
export function parseElicitation(params: unknown): AcpElicitation | undefined {
  const p = params as { mode?: string; sessionId?: string; message?: string; requestedSchema?: Record<string, unknown> } | undefined
  const schema = (p?.requestedSchema ?? (params as { requested_schema?: Record<string, unknown> } | undefined)?.requested_schema) as { properties?: Record<string, Record<string, unknown>>; description?: string } | undefined
  if (!schema?.properties || (p?.mode && p.mode !== 'form')) return undefined
  const questions: AcpQuestion[] = []
  for (const [key, prop] of Object.entries(schema.properties)) {
    const titled = (v: unknown): string[] => (Array.isArray(v) ? v.map((o) => (o as { const?: unknown })?.const).filter((c): c is string => typeof c === 'string') : [])
    const text = String(prop.description ?? prop.title ?? key)
    const header = typeof prop.title === 'string' && prop.description ? prop.title : undefined
    if (prop.type === 'array') {
      const items = (prop.items ?? {}) as { anyOf?: unknown; enum?: unknown }
      const options = items.anyOf ? titled(items.anyOf) : Array.isArray(items.enum) ? items.enum.filter((e): e is string => typeof e === 'string') : []
      questions.push({ key, header, question: text, options, multi: true })
    } else if (prop.type === 'string') {
      const options = prop.oneOf ? titled(prop.oneOf) : Array.isArray(prop.enum) ? prop.enum.filter((e): e is string => typeof e === 'string') : []
      questions.push({ key, header, question: text, options, multi: false })
    } else return undefined
  }
  if (!questions.length) return undefined
  return { sessionId: p?.sessionId, message: p?.message, footer: schema.description || undefined, questions }
}

export interface AcpModes {
  currentModeId: string
  availableModes: { id: string; name: string; description?: string }[]
}

export class AcpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/**
 * Minimal Agent Client Protocol client over a child process (newline-delimited JSON-RPC 2.0).
 * We advertise no fs/terminal client capabilities, so the agent uses its own tools inside `cwd`.
 *
 * Events: 'update' (session/update params), 'permission' (req, respond), 'elicitation' (req, respond), 'exit' (code), 'stderr' (text).
 */
export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  exited = false

  start(command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): void {
    const proc = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.on('error', (e) => this.fail(new AcpError(`Cannot start ${command}: ${e.message}`)))
    proc.on('exit', (code) => {
      this.exited = true
      this.fail(new AcpError(`Agent exited (code ${code})`))
      this.emit('exit', code)
    })
    proc.stderr.on('data', (d: Buffer) => this.emit('stderr', d.toString()))
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
  }

  private fail(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private write(msg: object): void {
    if (this.exited || !this.proc?.stdin.writable) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.exited) return reject(new AcpError('Agent is not running'))
      const id = this.nextId++
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params })
  }

  private onLine(line: string): void {
    let m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
    try {
      m = JSON.parse(line)
    } catch {
      return // agents must keep stdout for protocol messages; ignore stray output
    }
    if (m.method && m.id !== undefined) return void this.onAgentRequest(m.id, m.method, m.params)
    if (m.method) {
      if (m.method === 'session/update') this.emit('update', m.params)
      return
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new AcpError(m.error.message, m.error.code))
      else p.resolve(m.result)
    }
  }

  private onAgentRequest(id: number | string, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      let answered = false
      const respond = (optionId: string | null): void => {
        if (answered) return
        answered = true
        this.write({ id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } })
      }
      this.emit('permission', params as AcpPermissionRequest, respond)
      return
    }
    if (method === 'elicitation/create') {
      const req = parseElicitation(params)
      if (!req) return this.write({ id, result: { action: 'decline' } })
      let answered = false
      /** `answers` null = the user dismissed it. */
      const respond = (answers: AcpElicitationAnswers | null): void => {
        if (answered) return
        answered = true
        this.write({ id, result: answers ? { action: 'accept', content: answers } : { action: 'cancel' } })
      }
      this.emit('elicitation', req, respond)
      return
    }
    this.write({ id, error: { code: -32601, message: `Method not supported: ${method}` } })
  }

  /**
   * `delegatedBrowserAuth` tells Vibe this client opens the sign-in page itself (in its own window), so Vibe
   * offers the `browser-auth-delegated` method and hands back the URL instead of launching a system browser.
   */
  initialize(opts: { delegatedBrowserAuth?: boolean } = {}): Promise<{ authMethods?: AcpAuthMethod[]; agentInfo?: { name: string; version: string }; agentCapabilities?: AcpCapabilities }> {
    // `elicitation.form` is what makes Vibe offer its ask_user_question tool at all.
    const clientCapabilities = { elicitation: { form: {} }, ...(opts.delegatedBrowserAuth ? { _meta: { 'browser-auth-delegated': true } } : {}) }
    return this.request('initialize', { protocolVersion: 1, clientCapabilities, clientInfo: { name: 'mistral-desktop', version: '0.1.0' } })
  }

  authenticate(methodId: string, extra: Record<string, unknown> = {}): Promise<{ _meta?: Record<string, Record<string, unknown>> } | null | undefined> {
    return this.request('authenticate', { methodId, ...extra })
  }

  newSession(cwd: string, mcpServers: unknown[]): Promise<{ sessionId: string; modes?: AcpModes; configOptions?: unknown }> {
    return this.request('session/new', { cwd, mcpServers })
  }

  listSessions(cwd: string, cursor?: string): Promise<{ sessions: AcpSessionInfo[]; nextCursor?: string | null }> {
    return this.request('session/list', { cwd, ...(cursor ? { cursor } : {}) })
  }

  /** Replays the stored conversation as session/update notifications before resolving. */
  loadSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<{ modes?: AcpModes; configOptions?: unknown }> {
    return this.request('session/load', { sessionId, cwd, mcpServers })
  }

  /** Changes a session setting (`model`, `thinking`, ...) and returns the updated option list. */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions?: unknown }> {
    return this.request('session/set_config_option', { sessionId, configId, value })
  }

  /** Vibe extension methods (JSON-RPC names start with an underscore). */
  renameSession(sessionId: string, title: string): Promise<unknown> {
    return this.request('_session/set_title', { sessionId, title })
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.request('_session/delete', { sessionId })
  }

  closeSession(sessionId: string): Promise<unknown> {
    return this.request('session/close', { sessionId })
  }

  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId })
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request('session/set_mode', { sessionId, modeId })
  }

  kill(): void {
    this.exited = true
    this.fail(new AcpError('Agent stopped'))
    this.proc?.kill()
  }
}
