import type { McpServerConfig } from '@shared/types'

/**
 * Parse the common `{ "mcpServers": { name: { command, args, env } } }` format (Claude Desktop, Cursor, VS Code `servers`, ...).
 * Entries with a `url` become remote servers; OAuth sign-in is switched on unless the entry already carries an
 * Authorization header. Entries with neither `command` nor `url` are reported as skipped.
 */
export function parseMcpJson(text: string): { servers: McpServerConfig[]; skipped: string[] } {
  const raw = JSON.parse(text) as Record<string, unknown>
  const map = (raw.mcpServers ?? raw.servers ?? raw) as Record<string, unknown>
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Expected an object of servers')
  const servers: McpServerConfig[] = []
  const skipped: string[] = []
  const strMap = (o: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries((o as Record<string, unknown>) ?? {})) out[k] = String(v)
    return out
  }
  for (const [name, v] of Object.entries(map)) {
    const e = v as { command?: unknown; args?: unknown; env?: unknown; disabled?: unknown; url?: unknown; serverUrl?: unknown; headers?: unknown }
    const enabled = !e || typeof e !== 'object' ? false : e.disabled !== true
    const url = typeof e?.url === 'string' ? e.url : typeof e?.serverUrl === 'string' ? e.serverUrl : ''
    if (e && typeof e === 'object' && typeof e.command === 'string' && e.command) {
      servers.push({ id: crypto.randomUUID(), name, command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], env: strMap(e.env), enabled })
    } else if (e && typeof e === 'object' && url) {
      const headers = strMap(e.headers)
      const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')
      servers.push({ id: crypto.randomUUID(), name, transport: 'http', url, headers, oauth: !hasAuth, command: '', args: [], env: {}, enabled })
    } else skipped.push(name)
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

export const headersToText = (h: Record<string, string> | undefined): string => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
export function textToHeaders(t: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of t.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}
