import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import type { ChatEvent, Conversation, Settings, WireMessage } from '../shared/types'
import { runChat } from './chat/run'
import { listModels } from './chat/mistral'
import { CodeService } from './code/service'
import { ConversationStore } from './conversations'
import { McpHost } from './mcp/host'
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
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  const dir = process.env.MISTRAL_DESKTOP_DATA || app.getPath('userData')
  const strongEncryption = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false
    // On Linux without a keyring Electron falls back to a hardcoded key ("basic_text"): not real protection.
    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    return backend !== 'basic_text'
  }
  const settings = new SettingsStore(dir, {
    available: strongEncryption,
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b)
  })
  const convs = new ConversationStore(join(dir, 'conversations'))
  const mcp = new McpHost()
  mcp.onChange = () => send('mcp:changed', mcp.status())
  const code = new CodeService(settings, (id, e) => send('code:event', id, e))
  void mcp.sync(settings.get().mcpServers)

  // ---- settings ----
  ipcMain.handle('settings:get', () => settings.view())
  ipcMain.handle('settings:update', async (_e, patch: Partial<Settings>) => {
    settings.update(patch)
    if (patch.mcpServers) void mcp.sync(settings.get().mcpServers)
    return settings.view()
  })
  ipcMain.handle('settings:setApiKey', (_e, key: string) => (settings.setApiKey(key), settings.view()))
  ipcMain.handle('settings:clearApiKey', () => (settings.clearApiKey(), settings.view()))

  // ---- chat ----
  const runs = new Map<string, AbortController>()
  const approvals = new Map<string, { requestId: string; resolve: (ok: boolean) => void }>()
  ipcMain.handle('chat:models', async () => {
    const key = settings.getApiKey()
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
    const key = settings.getApiKey()
    if (!key) return emit({ type: 'error', message: 'No API key set. Add your Mistral API key in Settings.' })
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

  // ---- mcp ----
  ipcMain.handle('mcp:status', () => mcp.status())

  // ---- code ----
  ipcMain.handle('code:pickFolder', async () => {
    if (process.env.MISTRAL_DESKTOP_TEST_FOLDER) return process.env.MISTRAL_DESKTOP_TEST_FOLDER // e2e hook: native dialogs cannot be automated
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a project folder' })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('code:start', (_e, cwd: string) => code.start(cwd))
  ipcMain.handle('code:authenticate', (_e, id: string, m: string) => code.authenticate(id, m))
  ipcMain.handle('code:prompt', (_e, id: string, text: string) => code.prompt(id, text))
  ipcMain.handle('code:cancel', (_e, id: string) => code.cancel(id))
  ipcMain.handle('code:setMode', (_e, id: string, m: string) => code.setMode(id, m))
  ipcMain.handle('code:permission', (_e, id: string, r: string, o: string | null) => code.respondPermission(id, r, o))
  ipcMain.handle('code:stop', (_e, id: string) => code.stop(id))

  app.on('before-quit', () => {
    code.stopAll()
    void mcp.shutdown()
  })
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
