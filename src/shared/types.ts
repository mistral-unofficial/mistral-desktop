// Types shared by main, preload and renderer. No runtime imports here.

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  /** Default is stdio. */
  transport?: 'stdio' | 'http'
  // stdio
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  // http (streamable HTTP, falling back to legacy SSE)
  url?: string
  headers?: Record<string, string>
  /** Use OAuth sign-in (discovered from the server) for this remote server. */
  oauth?: boolean
  /** Set on servers that come from an installed .mcpb extension; those are not stored in settings. */
  extensionId?: string
  /** Bumped when the extension is reinstalled/updated, so a running server restarts. */
  revision?: number
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
  /** Shown in the sidebar footer. Mistral's API does not tell the app who you are, so you enter it. */
  profileName: string
  profileEmail: string
}

export interface SettingsView extends Settings {
  hasApiKey: boolean
  /** True when the OS keychain is unavailable and the key is stored with file permissions only. */
  insecureKeyStorage: boolean
}

export type BrowserSignInResult = { ok: true } | { ok: false; error: string }

/** Who is signed in on the website. */
export interface AccountProfile {
  name?: string
  email?: string
  organization?: string
}

/** From the website's `billing.budget`: how much of the monthly budget is used. */
export interface AccountBudget {
  /** 0 to 100. */
  usagePercent: number
  initialBudget: number
  currency: string
  /** ISO date when the budget resets. */
  resetAt?: string
}

export interface AccountInfo {
  /** From Vibe's account lookup; absent when signed out or the lookup failed. */
  plan?: { name: string; type: string }
  /** True when the app holds a chat.mistral.ai web session (needed for the budget). */
  webSignedIn?: boolean
  budget?: AccountBudget
  /** From the website's `user.session`; present only with a web session. */
  profile?: AccountProfile
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

/** A conversation matching a search; `snippet` is the matching message text when the title did not match. */
export interface ConversationHit {
  id: string
  title: string
  updatedAt: number
  snippet?: string
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
  kind: 'stdio' | 'http'
  state: 'connecting' | 'connected' | 'error' | 'disabled' | 'needs-auth'
  error?: string
  tools: string[]
  extensionId?: string
}

// ---- MCPB extensions ----

export type UserConfigValue = string | number | boolean | string[]

export interface UserConfigField {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  default?: UserConfigValue
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
}

export interface ExtensionPreview {
  stagingId: string
  id: string
  name: string
  displayName: string
  version: string
  description: string
  author: string
  serverType: string
  command: string
  args: string[]
  tools: { name: string; description?: string }[]
  userConfig: Record<string, UserConfigField>
  /** Defaults, with ${HOME}-style variables already resolved. */
  defaults: Record<string, UserConfigValue>
  /** The bundle carries a signature block. The signature is NOT verified. */
  signed: boolean
  warnings: string[]
  fileCount: number
  sizeBytes: number
  icon?: string
  previous?: { version: string; values: Record<string, UserConfigValue>; secretKeys: string[] }
}

export interface InstalledExtension {
  id: string
  name: string
  displayName: string
  version: string
  description: string
  author: string
  serverType: string
  enabled: boolean
  userConfig: Record<string, UserConfigField>
  /** Current values; sensitive ones are never sent to the UI (see secretKeys). */
  values: Record<string, UserConfigValue>
  secretKeys: string[]
  missingRequired: string[]
  signed: boolean
  installedAt: number
  icon?: string
}

export type ExtensionResult<T = InstalledExtension> = { ok: true; extension: T } | { ok: false; error: string; fieldErrors?: Record<string, string> }

// ---- Code tab ----

export interface CodeMode {
  id: string
  name: string
  description?: string
}

export type CodeStartResult =
  | { status: 'ready'; id: string; modes: CodeMode[]; currentMode: string; canResume: boolean; /** The agent's id for this (new, still empty) session. */ sessionId: string; configOptions: CodeConfigOption[] }
  | { status: 'needs-auth'; id: string; authMethods: { id: string; name: string; description?: string }[]; message: string }
  | { status: 'error'; message: string }

/** A session setting the agent lets the user change, e.g. the model or the thinking level. */
export interface CodeConfigOption {
  id: string
  name: string
  category?: string
  value: string
  choices: { value: string; name: string; description?: string }[]
}

export type CodeConfigResult = { ok: true; options: CodeConfigOption[] } | { ok: false; error: string }

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

export interface CodeSessionInfo {
  sessionId: string
  title: string
  updatedAt: string | null
}

/** A project folder the user has opened, with the stored sessions Vibe has for it (newest first). */
export interface CodeWorkspace {
  path: string
  sessions: CodeSessionInfo[]
  /** Set when the folder is a linked git worktree created for a branch. */
  worktree?: { branch: string; mainRepo: string }
}

export type WorktreeCreateResult = { ok: true; path: string; branch: string } | { ok: false; error: string }
export type WorktreeRemoveResult = { ok: true } | { ok: false; error: string; dirty?: boolean }

/** Result of resuming a stored session; `history` is the replayed `session/update` stream. */
export type CodeResumeResult =
  | { status: 'ready'; modes: CodeMode[]; currentMode: string; configOptions: CodeConfigOption[]; history: (Record<string, unknown> & { sessionUpdate: string })[] }
  | { status: 'error'; message: string }

// ---- Work (internal chat.mistral.ai Work API) ----
export interface WorkChatSummary {
  id: string
  title: string
  updatedAt: number
  pinned: boolean
}
export interface WorkQuestion {
  question: string
  options: string[]
}
/** A pause in the agent's turn that waits for the user (e.g. "ask_user_question"). */
export interface WorkCallback {
  id: string
  name: string
  /** 'pending' while it waits for an answer. */
  status: 'pending' | 'submitted' | string
  questions: WorkQuestion[]
  /** The submitted answers, in question order. */
  answers?: string[]
}
/** The user's answer to a pending question callback. */
export interface WorkAnswer {
  messageId: string
  callbackId: string
  values: string[]
}
export interface WorkMessage {
  id: string
  role: 'user' | 'assistant'
  /** The visible answer (reasoning excluded). */
  text: string
  /** The model's reasoning, when the server sends it. */
  reasoning: string
  status: 'in-progress' | 'success' | 'error' | string
  callbacks?: WorkCallback[]
}
export interface WorkChat {
  id: string
  title: string
  messages: WorkMessage[]
}
export type WorkStatus = { signedIn: boolean }
export type WorkListResult = { ok: true; chats: WorkChatSummary[]; nextCursor?: string } | { ok: false; error: string }
export type WorkGetResult = { ok: true; chat: WorkChat } | { ok: false; error: string }
export type WorkEvent =
  /** A full snapshot of the chat while it streams (messages in order). */
  | { type: 'state'; chat: WorkChat }
  | { type: 'error'; message: string }
  | { type: 'done' }
