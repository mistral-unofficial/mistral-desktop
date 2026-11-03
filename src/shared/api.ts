import type { ChatEvent, CodeEvent, CodeStartResult, Conversation, McpServerStatus, Settings, SettingsView, WireMessage } from './types'

/** The API exposed on `window.api` by the preload script. */
export interface Api {
  settings: {
    get(): Promise<SettingsView>
    update(patch: Partial<Settings>): Promise<SettingsView>
    setApiKey(key: string): Promise<SettingsView>
    clearApiKey(): Promise<SettingsView>
  }
  chat: {
    models(): Promise<string[]>
    send(req: { requestId: string; messages: WireMessage[]; model: string }): Promise<void>
    cancel(requestId: string): Promise<void>
    approve(callId: string, allow: boolean): Promise<void>
    onEvent(cb: (requestId: string, e: ChatEvent) => void): () => void
  }
  conversations: {
    list(): Promise<Pick<Conversation, 'id' | 'title' | 'updatedAt'>[]>
    get(id: string): Promise<Conversation | undefined>
    save(c: Conversation): Promise<void>
    remove(id: string): Promise<void>
  }
  mcp: {
    status(): Promise<McpServerStatus[]>
    onChange(cb: (s: McpServerStatus[]) => void): () => void
  }
  code: {
    pickFolder(): Promise<string | undefined>
    start(cwd: string): Promise<CodeStartResult>
    authenticate(id: string, methodId: string): Promise<CodeStartResult>
    prompt(id: string, text: string): Promise<void>
    cancel(id: string): Promise<void>
    setMode(id: string, modeId: string): Promise<void>
    respondPermission(id: string, requestId: string, optionId: string | null): Promise<void>
    stop(id: string): Promise<void>
    onEvent(cb: (id: string, e: CodeEvent) => void): () => void
  }
}
