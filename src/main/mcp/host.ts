import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig, McpServerStatus } from '../../shared/types'
import type { ToolDef } from '../chat/mistral'
import { McpOAuthProvider, OAuthStore, startCallbackServer } from './oauth'

export interface ToolResult {
  text: string
  isError: boolean
}

export interface ToolProvider {
  tools(): ToolDef[]
  describe(wireName: string): { server: string; tool: string } | undefined
  call(wireName: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>
}

interface Live {
  cfg: McpServerConfig
  client?: Client
  state: McpServerStatus['state']
  error?: string
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
}

export interface HostDeps {
  oauth?: OAuthStore
  /** Opens the system browser for OAuth sign-in. */
  openExternal?: (url: string) => void | Promise<void>
}

/** Mistral tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function wireName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${clean(server)}__${clean(tool)}`.slice(0, 64)
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Remote servers must use https; plain http is only allowed to this machine. */
export function validateRemoteUrl(raw: string | undefined): URL {
  let u: URL
  try {
    u = new URL(raw ?? '')
  } catch {
    throw new Error('Invalid server URL')
  }
  if (u.username || u.password) throw new Error('Put credentials in headers, not in the URL')
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return u
  throw new Error('Remote MCP servers must use https:// (http:// is only allowed for localhost)')
}

const CONNECT_TIMEOUT = 20_000

/** The SDK reports a 401 as UnauthorizedError with an auth provider, and as a plain HTTP error without one. */
function isAuthError(e: unknown): boolean {
  return e instanceof UnauthorizedError || (e as { code?: number })?.code === 401 || /\b401\b/.test((e as Error)?.message ?? '')
}

export class McpHost implements ToolProvider {
  private live = new Map<string, Live>()
  private names = new Map<string, { server: string; tool: string; liveId: string; rawTool: string }>()
  private chain: Promise<void> = Promise.resolve()
  private authorizing = new Set<string>()
  onChange?: () => void
  constructor(private deps: HostDeps = {}) {}

  /** Calls are serialised, so overlapping updates (e.g. while typing in settings) cannot interleave or leak connections. */
  sync(configs: McpServerConfig[]): Promise<void> {
    const run = this.chain.then(() => this.doSync(configs))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async doSync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.id))
    for (const [id, l] of [...this.live]) {
      const next = configs.find((c) => c.id === id)
      if (!next || JSON.stringify(next) !== JSON.stringify(l.cfg)) await this.stop(id)
    }
    for (const id of [...this.live.keys()]) if (!wanted.has(id)) this.live.delete(id)
    await Promise.all(configs.map((c) => (this.live.has(c.id) ? undefined : this.start(c))))
    this.rebuildNames()
    this.onChange?.()
  }

  private async start(cfg: McpServerConfig): Promise<void> {
    const l: Live = { cfg, state: cfg.enabled ? 'connecting' : 'disabled', tools: [] }
    this.live.set(cfg.id, l)
    if (!cfg.enabled) return
    try {
      // Only use the OAuth machinery when we already hold tokens. Otherwise connect plainly: this works for servers
      // that need no auth, and a 401 just means "needs sign-in" without registering a client behind the user's back.
      const hasTokens = !!this.deps.oauth?.get(cfg.id).tokens
      const client = cfg.transport === 'http' ? await this.connectHttp(cfg, hasTokens ? this.providerFor(cfg, false) : undefined) : await this.connectStdio(cfg)
      client.onclose = () => {
        if (l.state === 'connected') {
          l.state = 'error'
          l.error = 'Connection closed'
          this.rebuildNames()
          this.onChange?.()
        }
      }
      l.tools = await this.listAllTools(client)
      if (this.live.get(cfg.id) !== l) {
        // Removed or replaced while connecting: do not keep a connection nobody owns.
        client.onclose = undefined
        await client.close().catch(() => undefined)
        return
      }
      l.client = client
      l.state = 'connected'
    } catch (e) {
      if (isAuthError(e) && cfg.oauth) {
        l.state = 'needs-auth'
      } else if (isAuthError(e)) {
        l.state = 'error'
        l.error = 'The server requires authentication. Add an Authorization header, or turn on OAuth sign-in.'
      } else {
        l.state = 'error'
        l.error = (e as Error).message
      }
    }
  }

  private async connectStdio(cfg: McpServerConfig): Promise<Client> {
    if (!cfg.command.trim()) throw new Error('No command set')
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd, stderr: 'ignore' })
    const client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    return client
  }

  private makeHttpTransport(kind: 'streamable' | 'sse', url: URL, headers: Record<string, string>, provider?: McpOAuthProvider): Transport {
    if (kind === 'streamable') return new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider: provider })
    return new SSEClientTransport(url, {
      requestInit: { headers },
      authProvider: provider,
      eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }) }
    })
  }

  /** Streamable HTTP first; legacy SSE servers are tried if that fails for a non-auth reason. */
  private async connectHttp(cfg: McpServerConfig, provider?: McpOAuthProvider): Promise<Client> {
    const url = validateRemoteUrl(cfg.url)
    const headers = cfg.headers ?? {}
    let client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
    try {
      await client.connect(this.makeHttpTransport('streamable', url, headers, provider), { timeout: CONNECT_TIMEOUT })
      return client
    } catch (first) {
      if (isAuthError(first)) throw first
      await client.close().catch(() => undefined)
      client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
      try {
        await client.connect(this.makeHttpTransport('sse', url, headers, provider), { timeout: CONNECT_TIMEOUT })
        return client
      } catch (second) {
        if (isAuthError(second)) throw second
        await client.close().catch(() => undefined)
        throw first // the streamable error is the more informative one
      }
    }
  }

  private providerFor(cfg: McpServerConfig, interactive: boolean, redirectUrl?: string, onState?: (s: string) => void): McpOAuthProvider | undefined {
    if (!cfg.oauth || !this.deps.oauth) return undefined
    const registered = this.deps.oauth.get(cfg.id).registeredRedirect
    return new McpOAuthProvider(cfg.id, this.deps.oauth, { redirectUrl: redirectUrl ?? registered ?? 'http://127.0.0.1/callback', interactive, openExternal: this.deps.openExternal, onState })
  }

  /** Interactive OAuth sign-in: opens the browser, waits for the redirect, stores tokens, reconnects. */
  async authorize(id: string): Promise<{ ok: boolean; error?: string }> {
    const l = this.live.get(id)
    if (!l || l.cfg.transport !== 'http' || !l.cfg.oauth || !this.deps.oauth) return { ok: false, error: 'This server does not use OAuth sign-in' }
    if (this.authorizing.has(id)) return { ok: false, error: 'Sign-in is already in progress' }
    this.authorizing.add(id)
    try {
      return await this.runAuthorize(id, l)
    } finally {
      this.authorizing.delete(id)
    }
  }

  private async runAuthorize(id: string, l: Live): Promise<{ ok: boolean; error?: string }> {
    const cb = await startCallbackServer(this.deps.oauth!.get(id).port)
    try {
      const provider = this.providerFor(l.cfg, true, cb.redirectUrl, (s) => cb.setExpectedState(s))!
      this.deps.oauth!.update(id, { port: cb.port })
      const url = validateRemoteUrl(l.cfg.url)
      const headers = l.cfg.headers ?? {}
      let transport = this.makeHttpTransport('streamable', url, headers, provider)
      let client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT })
      } catch (e) {
        if (!(e instanceof UnauthorizedError)) {
          // Maybe a legacy SSE server: retry the sign-in over SSE.
          await client.close().catch(() => undefined)
          transport = this.makeHttpTransport('sse', url, headers, provider)
          client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
          try {
            await client.connect(transport, { timeout: CONNECT_TIMEOUT })
          } catch (e2) {
            if (!(e2 instanceof UnauthorizedError)) throw e
          }
        }
        if (provider.pendingAuthUrl) {
          const code = await cb.waitForCode(5 * 60_000)
          await (transport as StreamableHTTPClientTransport).finishAuth(code)
        }
      }
      await client.close().catch(() => undefined)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      cb.close()
    }
    await this.restart(id)
    const st = this.live.get(id)
    return st?.state === 'connected' ? { ok: true } : { ok: false, error: st?.error ?? 'Could not connect after signing in' }
  }

  /** Forget stored OAuth credentials for a server and reconnect (it will show as needing sign-in). */
  async signOut(id: string): Promise<void> {
    this.deps.oauth?.clear(id)
    await this.restart(id)
  }

  accessToken(id: string): string | undefined {
    return this.deps.oauth?.accessToken(id)
  }

  async restart(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    await this.stop(id)
    await this.start(l.cfg)
    this.rebuildNames()
    this.onChange?.()
  }

  private async listAllTools(client: Client): Promise<Live['tools']> {
    const out: Live['tools'] = []
    let cursor: string | undefined
    do {
      const res = await client.listTools(cursor ? { cursor } : undefined)
      for (const t of res.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })
      cursor = res.nextCursor
    } while (cursor && out.length < 1000)
    return out
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id)
    this.live.delete(id)
    try {
      if (l?.client) l.client.onclose = undefined
      await l?.client?.close()
    } catch {
      /* already gone */
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)))
    this.rebuildNames()
  }

  private rebuildNames(): void {
    this.names.clear()
    for (const l of this.live.values()) {
      if (l.state !== 'connected') continue
      for (const t of l.tools) {
        let w = wireName(l.cfg.name, t.name)
        for (let i = 2; this.names.has(w); i++) w = `${wireName(l.cfg.name, t.name).slice(0, 60)}_${i}`
        this.names.set(w, { server: l.cfg.name, tool: t.name, liveId: l.cfg.id, rawTool: t.name })
      }
    }
  }

  status(): McpServerStatus[] {
    return [...this.live.values()].map((l) => ({ id: l.cfg.id, name: l.cfg.name, kind: l.cfg.transport === 'http' ? 'http' : 'stdio', state: l.state, error: l.error, tools: l.tools.map((t) => t.name), extensionId: l.cfg.extensionId }))
  }

  tools(): ToolDef[] {
    const out: ToolDef[] = []
    for (const [w, n] of this.names) {
      const t = this.live.get(n.liveId)?.tools.find((x) => x.name === n.rawTool)
      if (!t) continue
      out.push({ type: 'function', function: { name: w, description: `[${n.server}] ${t.description ?? ''}`.trim(), parameters: t.inputSchema ?? { type: 'object', properties: {} } } })
    }
    return out
  }

  describe(w: string): { server: string; tool: string } | undefined {
    const n = this.names.get(w)
    return n ? { server: n.server, tool: n.tool } : undefined
  }

  async call(w: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const n = this.names.get(w)
    const client = n ? this.live.get(n.liveId)?.client : undefined
    if (!n || !client) return { text: `Unknown or disconnected tool: ${w}`, isError: true }
    try {
      const res = await client.callTool({ name: n.rawTool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal })
      const parts = (res.content as { type: string; text?: string }[] | undefined) ?? []
      const text = parts.map((p) => (p.type === 'text' ? p.text ?? '' : `[${p.type} content omitted]`)).join('\n')
      return { text: text || JSON.stringify(res.structuredContent ?? {}), isError: !!res.isError }
    } catch (e) {
      return { text: (e as Error).message, isError: true }
    }
  }
}

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] }

/**
 * Convert app MCP configs to the shape ACP's session/new expects.
 * OAuth servers are passed with their current access token (Vibe has no access to our token store),
 * so they only work while that token is valid; servers that are not signed in yet are skipped.
 */
export function toAcpServers(configs: McpServerConfig[], accessToken?: (id: string) => string | undefined): AcpMcpServer[] {
  const out: AcpMcpServer[] = []
  for (const c of configs) {
    if (!c.enabled) continue
    if (c.transport === 'http') {
      try {
        validateRemoteUrl(c.url)
      } catch {
        continue
      }
      const headers = { ...(c.headers ?? {}) }
      if (c.oauth) {
        const t = accessToken?.(c.id)
        if (!t) continue
        headers.Authorization = `Bearer ${t}`
      }
      out.push({ type: 'http', name: c.name, url: c.url!, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) })
    } else if (c.command.trim()) {
      out.push({ name: c.name, command: c.command, args: c.args, env: Object.entries(c.env).map(([name, value]) => ({ name, value })) })
    }
  }
  return out
}
