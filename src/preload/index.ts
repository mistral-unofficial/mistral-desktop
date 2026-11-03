import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from '../shared/api'
import type { ChatEvent, CodeEvent, McpServerStatus } from '../shared/types'

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
    clearApiKey: () => inv('settings:clearApiKey')
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
    remove: (id) => inv('conv:remove', id)
  },
  mcp: {
    status: () => inv('mcp:status'),
    onChange: (cb) => sub<[McpServerStatus[]]>('mcp:changed', cb)
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
    onEvent: (cb) => sub<[string, CodeEvent]>('code:event', cb)
  }
}

contextBridge.exposeInMainWorld('api', api)
