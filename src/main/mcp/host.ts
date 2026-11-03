import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpServerStatus } from '../../shared/types'
import type { ToolDef } from '../chat/mistral'

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
  transport?: StdioClientTransport
  state: McpServerStatus['state']
  error?: string
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
}

/** Mistral tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function wireName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${clean(server)}__${clean(tool)}`.slice(0, 64)
}

export class McpHost implements ToolProvider {
  private live = new Map<string, Live>()
  private names = new Map<string, { server: string; tool: string; liveId: string; rawTool: string }>()
  onChange?: () => void

  async sync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.id))
    for (const [id, l] of this.live) {
      const next = configs.find((c) => c.id === id)
      if (!next || JSON.stringify(next) !== JSON.stringify(l.cfg)) {
        await this.stop(id)
      }
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
      const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env, stderr: 'ignore' })
      const client = new Client({ name: 'mistral-desktop', version: '0.1.0' })
      transport.onclose = () => {
        if (l.state === 'connected') {
          l.state = 'error'
          l.error = 'Server process exited'
          this.rebuildNames()
          this.onChange?.()
        }
      }
      await client.connect(transport)
      const res = await client.listTools()
      l.client = client
      l.transport = transport
      l.tools = res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }))
      l.state = 'connected'
    } catch (e) {
      l.state = 'error'
      l.error = (e as Error).message
    }
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id)
    this.live.delete(id)
    try {
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
    return [...this.live.values()].map((l) => ({ id: l.cfg.id, name: l.cfg.name, state: l.state, error: l.error, tools: l.tools.map((t) => t.name) }))
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

/** Convert app MCP configs to the shape ACP's session/new expects. */
export function toAcpServers(configs: McpServerConfig[]): { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] {
  return configs
    .filter((c) => c.enabled)
    .map((c) => ({ name: c.name, command: c.command, args: c.args, env: Object.entries(c.env).map(([name, value]) => ({ name, value })) }))
}
