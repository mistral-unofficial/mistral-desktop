import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '../shared/api'
import type { AccountInfo, ChatEvent, CodeEvent, InstalledExtension, McpServerStatus } from '../shared/types'

const inv = <T>(ch: string, ...a: unknown[]): Promise<T> => ipcRenderer.invoke(ch, ...a) as Promise<T>
const sub = <A extends unknown[]>(ch: string, cb: (...a: A) => void): (() => void) => {
  const h = (_: unknown, ...a: unknown[]): void => cb(...(a as A))
  ipcRenderer.on(ch, h)
  return () => ipcRenderer.removeListener(ch, h)
}

const api: Api = {
  settings: {
    get: () => inv('settings:get'),
    update: (p) => inv('settings:update', p),
    setApiKey: (k) => inv('settings:setApiKey', k),
    clearApiKey: () => inv('settings:clearApiKey'),
    signInWithBrowser: () => inv('settings:signInWithBrowser'),
    signOut: () => inv('settings:signOut')
  },
  account: {
    get: () => inv('account:get'),
    webSignIn: () => inv('account:webSignIn'),
    webSignOut: () => inv('account:webSignOut'),
    onUpdate: (cb) => sub<[AccountInfo]>('account:update', cb)
  },
  chat: {
    models: () => inv('chat:models'),
    send: (r) => inv('chat:send', r),
    cancel: (id) => inv('chat:cancel', id),
    approve: (id, allow) => inv('chat:approve', id, allow),
    onEvent: (cb) => sub<[string, ChatEvent]>('chat:event', cb)
  },
  conversations: {
    list: () => inv('conv:list'),
    get: (id) => inv('conv:get', id),
    save: (c) => inv('conv:save', c),
    remove: (id) => inv('conv:remove', id),
    search: (q) => inv('conv:search', q)
  },
  mcp: {
    status: () => inv('mcp:status'),
    authorize: (id) => inv('mcp:authorize', id),
    signOut: (id) => inv('mcp:signOut', id),
    onChange: (cb) => sub<[McpServerStatus[]]>('mcp:changed', cb)
  },
  extensions: {
    pick: () => inv('ext:pick'),
    previewFile: (file) => inv('ext:previewPath', webUtils.getPathForFile(file)),
    install: (sid, v) => inv('ext:install', sid, v),
    discard: (sid) => inv('ext:discard', sid),
    list: () => inv('ext:list'),
    setEnabled: (id, e) => inv('ext:setEnabled', id, e),
    configure: (id, v) => inv('ext:configure', id, v),
    uninstall: (id) => inv('ext:uninstall', id),
    onChange: (cb) => sub<[InstalledExtension[]]>('ext:changed', cb)
  },
  dialog: {
    pickPath: (kind) => inv('dialog:pickPath', kind)
  },
  code: {
    pickFolder: () => inv('code:pickFolder'),
    start: (cwd) => inv('code:start', cwd),
    authenticate: (id, m) => inv('code:authenticate', id, m),
    prompt: (id, t) => inv('code:prompt', id, t),
    cancel: (id) => inv('code:cancel', id),
    setMode: (id, m) => inv('code:setMode', id, m),
    respondPermission: (id, r, o) => inv('code:permission', id, r, o),
    stop: (id) => inv('code:stop', id),
    listSessions: (id) => inv('code:listSessions', id),
    resume: (id, sid) => inv('code:resume', id, sid),
    workspaces: () => inv('code:workspaces'),
    renameSession: (sid, title) => inv('code:renameSession', sid, title),
    deleteSession: (sid) => inv('code:deleteSession', sid),
    onEvent: (cb) => sub<[string, CodeEvent]>('code:event', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
