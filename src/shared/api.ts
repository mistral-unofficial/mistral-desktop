import type { ChatEvent, CodeEvent, CodeResumeResult, CodeSessionInfo, CodeStartResult, Conversation, ExtensionPreview, ExtensionResult, InstalledExtension, McpServerStatus, Settings, SettingsView, WireMessage, UserConfigValue } from './types'

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
    /** Interactive OAuth sign-in for a remote server (opens the system browser). */
    authorize(id: string): Promise<{ ok: boolean; error?: string }>
    signOut(id: string): Promise<void>
    onChange(cb: (s: McpServerStatus[]) => void): () => void
  }
  extensions: {
    /** Opens a file dialog and parses the chosen .mcpb. Resolves undefined if cancelled. */
    pick(): Promise<ExtensionPreview | { error: string } | undefined>
    /** Parse a dropped file (identified by its path in the preload via webUtils). */
    previewFile(file: File): Promise<ExtensionPreview | { error: string }>
    install(stagingId: string, values: Record<string, UserConfigValue | string>): Promise<ExtensionResult>
    discard(stagingId: string): Promise<void>
    list(): Promise<InstalledExtension[]>
    setEnabled(id: string, enabled: boolean): Promise<void>
    configure(id: string, values: Record<string, UserConfigValue | string>): Promise<ExtensionResult>
    uninstall(id: string): Promise<void>
    onChange(cb: (list: InstalledExtension[]) => void): () => void
  }
  dialog: {
    pickPath(kind: 'file' | 'directory'): Promise<string | undefined>
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
    listSessions(id: string): Promise<CodeSessionInfo[]>
    resume(id: string, sessionId: string): Promise<CodeResumeResult>
    onEvent(cb: (id: string, e: CodeEvent) => void): () => void
  }
}
