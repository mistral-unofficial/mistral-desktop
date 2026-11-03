import type { AccountInfo, BrowserSignInResult, ChatEvent, CodeEvent, CodeResumeResult, CodeSessionInfo, CodeStartResult, CodeWorkspace, Conversation, ConversationHit, ExtensionPreview, ExtensionResult, InstalledExtension, McpServerStatus, Settings, SettingsView, WireMessage, UserConfigValue } from './types'

/** The API exposed on `window.api` by the preload script. */
export interface Api {
  settings: {
    get(): Promise<SettingsView>
    update(patch: Partial<Settings>): Promise<SettingsView>
    setApiKey(key: string): Promise<SettingsView>
    clearApiKey(): Promise<SettingsView>
    /** Sign in through the browser (via Vibe) and store the resulting API key. Needs Vibe installed. */
    signInWithBrowser(): Promise<BrowserSignInResult>
    /** Removes the API key and the web login kept by this app. */
    signOut(): Promise<SettingsView>
  }
  account: {
    /** Plan (from Vibe's account lookup) and, with a web session, the budget. */
    get(): Promise<AccountInfo>
    /** Opens chat.mistral.ai in an app window for sign-in (budget); resolves when it is closed. */
    webSignIn(): Promise<AccountInfo>
    webSignOut(): Promise<AccountInfo>
    /** Called with every fresh answer, e.g. the background refresh after the cached one was shown. */
    onUpdate(cb: (info: AccountInfo) => void): () => void
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
    /** Case-insensitive search over titles and message text, newest first. */
    search(query: string): Promise<ConversationHit[]>
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
    /** Recently opened folders with their stored sessions. Starts a short-lived Vibe process to read them. */
    workspaces(): Promise<CodeWorkspace[]>
    resume(id: string, sessionId: string): Promise<CodeResumeResult>
    /** Renames a stored session through Vibe. Resolves to an error message, or undefined on success. */
    renameSession(sessionId: string, title: string): Promise<string | undefined>
    /** Deletes a stored session through Vibe (the open one is stopped too). Resolves to an error message, or undefined. */
    deleteSession(sessionId: string): Promise<string | undefined>
    onEvent(cb: (id: string, e: CodeEvent) => void): () => void
  }
}
