// Types shared by main, preload and renderer. No runtime imports here.

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

export interface Settings {
  apiBase: string
  model: string
  /** Path to the vibe-acp executable; empty = look it up on PATH. */
  vibePath: string
  /** Optional isolated VIBE_HOME for the Code tab. */
  vibeHome: string
  mcpServers: McpServerConfig[]
  recentFolders: string[]
}

export interface SettingsView extends Settings {
  hasApiKey: boolean
  /** True when the OS keychain is unavailable and the key is stored with file permissions only. */
  insecureKeyStorage: boolean
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

/** What the renderer keeps for display and persistence. */
export type DisplayItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; server: string; tool: string; args: string; status: 'pending' | 'running' | 'done' | 'error' | 'denied'; result?: string }
  | { kind: 'error'; text: string }

export interface Conversation {
  id: string
  title: string
  updatedAt: number
  model: string
  items: DisplayItem[]
  /** Wire-level history, needed to continue the conversation including tool turns. */
  wire: WireMessage[]
}

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_pending'; id: string; server: string; tool: string; args: string }
  | { type: 'tool_running'; id: string }
  | { type: 'tool_result'; id: string; text: string; isError: boolean; denied?: boolean }
  | { type: 'wire'; messages: WireMessage[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface McpServerStatus {
  id: string
  name: string
  state: 'connecting' | 'connected' | 'error' | 'disabled'
  error?: string
  tools: string[]
}

// ---- Code tab ----

export interface CodeMode {
  id: string
  name: string
  description?: string
}

export type CodeStartResult =
  | { status: 'ready'; id: string; modes: CodeMode[]; currentMode: string }
  | { status: 'needs-auth'; id: string; authMethods: { id: string; name: string; description?: string }[]; message: string }
  | { status: 'error'; message: string }

export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

/** Subset of ACP session updates the UI cares about, passed through mostly as-is. */
export type CodeEvent =
  | { type: 'update'; update: Record<string, unknown> & { sessionUpdate: string } }
  | { type: 'permission'; requestId: string; title: string; options: PermissionOption[]; toolCall: Record<string, unknown> }
  | { type: 'turn-end'; stopReason: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null }
