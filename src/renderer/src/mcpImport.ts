import type { McpServerConfig } from '@shared/types'

/**
 * Parse the common `{ "mcpServers": { name: { command, args, env } } }` format (Claude Desktop,
 * Cursor, VS Code `servers`, etc.). Entries without a command (remote/HTTP servers) are reported
 * as skipped rather than silently dropped.
 */
export function parseMcpJson(text: string): { servers: McpServerConfig[]; skipped: string[] } {
  const raw = JSON.parse(text) as Record<string, unknown>
  const map = (raw.mcpServers ?? raw.servers ?? raw) as Record<string, unknown>
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected an object of servers')
  const servers: McpServerConfig[] = []
  const skipped: string[] = []
  for (const [name, v] of Object.entries(map)) {
    const e = v as { command?: unknown; args?: unknown; env?: unknown; disabled?: unknown }
    if (!e || typeof e !== 'object' || typeof e.command !== 'string' || !e.command) {
      skipped.push(name)
      continue
    }
    const env: Record<string, string> = {}
    for (const [k, val] of Object.entries((e.env as Record<string, unknown>) ?? {})) env[k] = String(val)
    servers.push({ id: crypto.randomUUID(), name, command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], env, enabled: e.disabled !== true })
  }
  return { servers, skipped }
}

export const argsToText = (a: string[]): string => a.join('\n')
export const textToArgs = (t: string): string[] => t.split('\n').map((l) => l.trim()).filter(Boolean)
export const envToText = (e: Record<string, string>): string => Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n')
export function textToEnv(t: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1)
  }
  return out
}
