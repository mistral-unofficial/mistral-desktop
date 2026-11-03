import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, shell } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { ChatEvent, Conversation, ExtensionPreview, McpServerConfig, Settings, UserConfigValue, WireMessage } from '../shared/types'
import { runChat } from './chat/run'
import { listModels } from './chat/mistral'
import { CodeService } from './code/service'
import { AccountService } from './account'
import { WebSession } from './web-session'
import { ConversationStore } from './conversations'
import { McpHost, toAcpServers } from './mcp/host'
import { OAuthStore } from './mcp/oauth'
import { LIMITS } from './mcpb/bundle'
import { ExtensionStore } from './mcpb/store'
import { SecretVault } from './vault'
import { SettingsStore } from './settings'

const FALLBACK_MODELS = ['mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest', 'codestral-latest']

let win: BrowserWindow | null = null
const send = (ch: string, ...a: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, ...a)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Mistral Desktop',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Application menu: the standard menus plus Settings… (Cmd+, on macOS, Ctrl+, elsewhere), which the window opens as its Settings dialog. */
function buildAppMenu(openSettings: () => void): Menu {
  const settingsItem: Electron.MenuItemConstructorOptions = { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings }
  const mac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(mac
      ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] } as Electron.MenuItemConstructorOptions]
      : []),
    { label: 'File', submenu: [...(mac ? [] : [settingsItem, { type: 'separator' } as Electron.MenuItemConstructorOptions]), mac ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ])
}

app.whenReady().then(async () => {
  const dir = process.env.MISTRAL_DESKTOP_DATA || app.getPath('userData')
  const strongEncryption = async (): Promise<boolean> => {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (!available) return false
    // On Linux without a keyring Electron falls back to a hardcoded key ("basic_text"): not real protection.
    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    return backend !== 'basic_text'
  }
  // The async safeStorage API; the sync one (encryptString, decryptString, isEncryptionAvailable) is deprecated.
  const crypto = {
    available: strongEncryption,
    encrypt: (s: string) => safeStorage.encryptStringAsync(s),
    decrypt: async (b: Buffer) => (await safeStorage.decryptStringAsync(b)).result
  }
  const settings = new SettingsStore(dir, crypto)
  const convs = new ConversationStore(join(dir, 'conversations'))
  const vault = new SecretVault(dir, crypto)
  const extensions = new ExtensionStore(join(dir, 'extensions'), vault, {
    systemDirs: () => ({ HOME: app.getPath('home'), DESKTOP: app.getPath('desktop'), DOCUMENTS: app.getPath('documents'), DOWNLOADS: app.getPath('downloads') }),
    execPath: process.execPath
  })
  // Opens the user's browser for OAuth sign-in. The test hook lets e2e runs play the browser's part.
  const openExternal = async (url: string): Promise<void> => {
    if (process.env.MISTRAL_DESKTOP_TEST_BROWSER === 'fetch') return void (await fetch(url, { redirect: 'follow' }))
    if (!/^https?:\/\//.test(url)) throw new Error('Refusing to open a non-http URL')
    await shell.openExternal(url)
  }
  const oauth = new OAuthStore(vault)
  const mcp = new McpHost({ oauth, openExternal })
  mcp.onChange = () => send('mcp:changed', mcp.status())
  /** Manually configured servers plus those provided by installed extensions. */
  const allServers = async (): Promise<McpServerConfig[]> => [...(settings.get()).mcpServers, ...(await extensions.servers())]
  const resync = (): void => void allServers().then((s) => mcp.sync(s))
  // Settings edits arrive per keystroke; wait for a pause so half-typed URLs/commands are never connected to.
  let resyncTimer: NodeJS.Timeout | undefined
  const resyncSoon = (): void => {
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(resync, 600)
  }
  extensions.onChange = async () => {
    send('ext:changed', await extensions.list())
    resync()
  }
  const web = new WebSession(() => win)
  const account = new AccountService(fetch, web, join(dir, 'account-cache.json'), (info) => send('account:update', info))
  const code = new CodeService(settings, (id, e) => send('code:event', id, e), async () => toAcpServers(await allServers(), async (id) => mcp.accessToken(id)), undefined, join(dir, 'worktrees'))
  resync()

  // ---- settings ----
  ipcMain.handle('settings:get', async () => settings.view())
  ipcMain.handle('settings:update', async (_e, patch: Partial<Settings>) => {
    settings.update(patch)
    if (patch.mcpServers) resyncSoon()
    return settings.view()
  })
  ipcMain.handle('settings:setApiKey', async (_e, key: string) => (await settings.setApiKey(key), void account.refresh(await settings.getApiKey(), settings.get().apiBase), settings.view()))
  ipcMain.handle('settings:clearApiKey', async () => (settings.clearApiKey(), settings.view()))
  // "Sign in: Vibe Code": Vibe's browser sign-in creates the API key used by Code and Chat. Independent of Le Chat.
  ipcMain.handle('settings:signInWithBrowser', async () => {
    const r = await code.signInWithBrowser(web)
    void account.refresh(await settings.getApiKey(), settings.get().apiBase)
    return r
  })
  // Signing out of Vibe Code forgets the app's API key only. Le Chat (name, organisation, budget) stays signed in, and
  // so does Vibe's own stored sign-in used by the `vibe` command.
  ipcMain.handle('settings:signOut', async () => {
    settings.clearApiKey()
    void account.refresh(undefined)
    return settings.view()
  })

  // ---- account ----
  ipcMain.handle('account:get', async () => account.get(await settings.getApiKey(), settings.get().apiBase))
  // Opens the website's own sign-in in the app's window; resolves when the window is closed.
  ipcMain.handle('account:webSignIn', async () => {
    await web.signInInWindow('https://chat.mistral.ai/code')
    return account.refresh(await settings.getApiKey(), settings.get().apiBase)
  })
  // "Sign out: Le Chat": forgets the web login (and so name, organisation and budget). The API key stays.
  ipcMain.handle('account:webSignOut', async () => (await web.signOut(), account.clear(), account.refresh(await settings.getApiKey(), settings.get().apiBase)))
  // Start loading right away so the name and plan are ready by the time the sidebar asks.
  void account.refresh(await settings.getApiKey(), settings.get().apiBase)

  // ---- chat ----
  const runs = new Map<string, AbortController>()
  const approvals = new Map<string, { requestId: string; resolve: (ok: boolean) => void }>()
  ipcMain.handle('chat:models', async () => {
    const key = await settings.getApiKey()
    if (!key) return FALLBACK_MODELS
    try {
      const m = await listModels(settings.get().apiBase, key)
      return m.length ? m : FALLBACK_MODELS
    } catch {
      return FALLBACK_MODELS
    }
  })
  ipcMain.handle('chat:send', async (_e, req: { requestId: string; messages: WireMessage[]; model: string }) => {
    const emit = (e: ChatEvent): void => send('chat:event', req.requestId, e)
    const key = await settings.getApiKey()
    if (!key) return emit({ type: 'error', message: 'Not signed in. Sign in with Mistral or add an API key in Settings.' })
    const ac = new AbortController()
    runs.set(req.requestId, ac)
    try {
      await runChat(req.messages, {
        apiBase: settings.get().apiBase,
        apiKey: key,
        model: req.model,
        tools: mcp,
        emit,
        signal: ac.signal,
        approve: (call) =>
          new Promise<boolean>((resolve) => {
            if (ac.signal.aborted) return resolve(false)
            approvals.set(call.id, { requestId: req.requestId, resolve })
          })
      })
    } finally {
      runs.delete(req.requestId)
    }
  })
  ipcMain.handle('chat:cancel', (_e, requestId: string) => {
    runs.get(requestId)?.abort()
    for (const [id, a] of approvals) if (a.requestId === requestId) (a.resolve(false), approvals.delete(id))
  })
  ipcMain.handle('chat:approve', (_e, callId: string, allow: boolean) => {
    const a = approvals.get(callId)
    if (a) (approvals.delete(callId), a.resolve(allow))
  })

  // ---- conversations ----
  ipcMain.handle('conv:list', () => convs.list())
  ipcMain.handle('conv:get', (_e, id: string) => convs.get(id))
  ipcMain.handle('conv:save', (_e, c: Conversation) => convs.save(c))
  ipcMain.handle('conv:remove', (_e, id: string) => convs.remove(id))
  ipcMain.handle('conv:search', (_e, q: string) => convs.search(q))

  // ---- mcp ----
  ipcMain.handle('mcp:status', () => mcp.status())
  ipcMain.handle('mcp:authorize', (_e, id: string) => mcp.authorize(id))
  ipcMain.handle('mcp:signOut', (_e, id: string) => mcp.signOut(id))

  // ---- extensions (.mcpb) ----
  const previewPath = async (path: string): Promise<ExtensionPreview | { error: string }> => {
    try {
      if (!['.mcpb', '.dxt'].includes(extname(path).toLowerCase())) return { error: 'Please choose a .mcpb file' }
      if (statSync(path).size > LIMITS.archiveBytes) return { error: 'Bundle is larger than 150 MB' }
      return extensions.preview(readFileSync(path))
    } catch (e) {
      return { error: (e as Error).message }
    }
  }
  ipcMain.handle('ext:pick', async () => {
    const test = process.env.MISTRAL_DESKTOP_TEST_MCPB // e2e hook: native dialogs cannot be automated
    if (test) return previewPath(test)
    const r = await dialog.showOpenDialog(win!, { title: 'Install extension', properties: ['openFile'], filters: [{ name: 'MCP bundle', extensions: ['mcpb', 'dxt'] }] })
    return r.canceled || !r.filePaths[0] ? undefined : previewPath(r.filePaths[0])
  })
  ipcMain.handle('ext:previewPath', async (_e, path: string) => previewPath(path))
  ipcMain.handle('ext:install', async (_e, sid: string, values: Record<string, UserConfigValue | string>) => extensions.install(sid, values))
  ipcMain.handle('ext:discard', (_e, sid: string) => extensions.discard(sid))
  ipcMain.handle('ext:list', async () => extensions.list())
  ipcMain.handle('ext:setEnabled', (_e, id: string, enabled: boolean) => extensions.setEnabled(id, enabled))
  ipcMain.handle('ext:configure', async (_e, id: string, values: Record<string, UserConfigValue | string>) => extensions.configure(id, values))
  ipcMain.handle('ext:uninstall', async (_e, id: string) => extensions.uninstall(id))
  ipcMain.handle('dialog:pickPath', async (_e, kind: 'file' | 'directory') => {
    if (process.env.MISTRAL_DESKTOP_TEST_FOLDER && kind === 'directory') return process.env.MISTRAL_DESKTOP_TEST_FOLDER
    const r = await dialog.showOpenDialog(win!, { properties: [kind === 'directory' ? 'openDirectory' : 'openFile'] })
    return r.canceled ? undefined : r.filePaths[0]
  })

  // ---- code ----
  ipcMain.handle('code:pickFolder', async () => {
    if (process.env.MISTRAL_DESKTOP_TEST_FOLDER) return process.env.MISTRAL_DESKTOP_TEST_FOLDER // e2e hook: native dialogs cannot be automated
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('code:start', (_e, cwd: string) => code.start(cwd))
  ipcMain.handle('code:authenticate', (_e, id: string, m: string) => code.authenticate(id, m))
  ipcMain.handle('code:prompt', (_e, id: string, text: string) => code.prompt(id, text))
  ipcMain.handle('code:listFiles', (_e, id: string) => code.listFiles(id).catch(() => ({ entries: [], truncated: false })))
  ipcMain.handle('code:cancel', (_e, id: string) => code.cancel(id))
  ipcMain.handle('code:setMode', (_e, id: string, m: string) => code.setMode(id, m))
  ipcMain.handle('code:permission', (_e, id: string, r: string, o: string | null) => code.respondPermission(id, r, o))
  ipcMain.handle('code:stop', (_e, id: string) => code.stop(id))
  ipcMain.handle('code:listSessions', (_e, id: string) => code.listSessions(id).catch(() => []))
  ipcMain.handle('code:workspaces', () => code.listWorkspaces())
  ipcMain.handle('code:setConfig', (_e, id: string, configId: string, value: string) => code.setConfigOption(id, configId, value))
  ipcMain.handle('code:createWorktree', (_e, folder: string, branch: string) => code.createWorktree(folder, branch))
  ipcMain.handle('code:removeWorktree', (_e, folder: string, force: boolean) => code.removeWorktree(folder, force))
  ipcMain.handle('code:renameSession', (_e, sid: string, title: string) => code.renameSession(sid, title))
  ipcMain.handle('code:deleteSession', (_e, sid: string) => code.deleteSession(sid))
  ipcMain.handle('code:resume', (_e, id: string, sid: string) => code.resume(id, sid))

  app.on('before-quit', () => {
    code.stopAll()
    void mcp.shutdown()
  })
  Menu.setApplicationMenu(buildAppMenu(() => send('app:openSettings')))
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
