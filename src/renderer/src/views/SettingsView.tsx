import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus, SettingsView as SV } from '@shared/types'
import { argsToText, envToText, headersToText, parseMcpJson, textToArgs, textToEnv, textToHeaders } from '../mcpImport'
import { ExtensionsSection } from './ExtensionsSection'

export function SettingsView() {
  const [s, setS] = useState<SV>()
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [importText, setImportText] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    void window.api.settings.get().then(setS)
    void window.api.mcp.status().then(setStatus)
    return window.api.mcp.onChange(setStatus)
  }, [])
  if (!s) return <div className="center muted">Loading…</div>

  const patch = async (p: Partial<SV>): Promise<void> => setS(await window.api.settings.update(p))
  const setServers = (servers: McpServerConfig[]): Promise<void> => patch({ mcpServers: servers })
  const edit = (id: string, p: Partial<McpServerConfig>): Promise<void> => setServers(s.mcpServers.map((m) => (m.id === id ? { ...m, ...p } : m)))
  const stat = (id: string): McpServerStatus | undefined => status.find((x) => x.id === id)

  const doImport = async (): Promise<void> => {
    try {
      const { servers, skipped } = parseMcpJson(importText)
      const names = new Set(s.mcpServers.map((m) => m.name))
      const fresh = servers.filter((x) => !names.has(x.name))
      await setServers([...s.mcpServers, ...fresh])
      setNote(`Imported ${fresh.length} server(s)${servers.length - fresh.length ? `, ${servers.length - fresh.length} already existed` : ''}${skipped.length ? `. Skipped (no command or url): ${skipped.join(', ')}` : ''}.`)
      setImportText('')
    } catch (e) {
      setNote(`Could not import: ${(e as Error).message}`)
    }
  }

  return (
    <div className="settings">
      <h2>Settings</h2>

      <section>
        <h3>Mistral API key</h3>
        <p className="muted">Used for Chat and passed to Vibe for Code. Create one at console.mistral.ai. {s.hasApiKey ? '✓ A key is set.' : 'No key set.'}</p>
        {s.insecureKeyStorage && <p className="warnline">No OS keychain available: the key is stored in a file readable only by your user.</p>}
        <div className="row">
          <input type="password" autoComplete="off" value={key} placeholder={s.hasApiKey ? '•••••••• (enter a new key to replace)' : 'Paste API key'} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" disabled={!key.trim()} onClick={async () => { setS(await window.api.settings.setApiKey(key)); setKey('') }}>Save</button>
          {s.hasApiKey && <button onClick={async () => setS(await window.api.settings.clearApiKey())}>Remove</button>}
        </div>
        <p className="muted">Browser sign-in is available in the Code tab when Vibe offers it. It creates a key for Vibe only.</p>
      </section>

      <section>
        <h3>Chat</h3>
        <label className="field">Default model<input value={s.model} onChange={(e) => void patch({ model: e.target.value })} /></label>
        <label className="field">API base URL<input value={s.apiBase} onChange={(e) => void patch({ apiBase: e.target.value })} /></label>
      </section>

      <section>
        <h3>Code (Vibe)</h3>
        <label className="field"><span>Path to <code>vibe-acp</code> <span className="muted">(empty = auto-detect)</span></span><input value={s.vibePath} placeholder="vibe-acp" onChange={(e) => void patch({ vibePath: e.target.value })} /></label>
        <label className="field"><span>Vibe home <span className="muted">(optional, isolates Vibe's config and sessions)</span></span><input value={s.vibeHome} onChange={(e) => void patch({ vibeHome: e.target.value })} /></label>
        <p className="muted">Install Vibe with <code>uv tool install mistral-vibe</code>.</p>
      </section>

      <ExtensionsSection status={status} />

      <section>
        <h3>MCP servers</h3>
        <p className="muted">Local servers run on your machine with your permissions, so only add ones you trust. Remote servers are reached over https. All of them are available in Chat and are handed to Vibe in the Code tab.</p>
        {s.mcpServers.map((m) => {
          const st = stat(m.id)
          const remote = m.transport === 'http'
          return (
            <div key={m.id} className="mcpcard" data-testid={`server-${m.name}`}>
              <div className="row">
                <label className="check"><input type="checkbox" checked={m.enabled} onChange={(e) => void edit(m.id, { enabled: e.target.checked })} /> Enabled</label>
                <input value={m.name} aria-label="Name" onChange={(e) => void edit(m.id, { name: e.target.value })} />
                <span className="muted">{remote ? 'remote' : 'local'}</span>
                <span className={`badge ${st?.state ?? ''}`}>{st?.state ?? 'saved'}</span>
                <button onClick={() => void setServers(s.mcpServers.filter((x) => x.id !== m.id))}>Remove</button>
              </div>
              {st?.error && <div className="warnline">{st.error}</div>}
              {st?.state === 'connected' && <div className="muted">Tools: {st.tools.join(', ') || 'none'}</div>}
              {remote ? (
                <>
                  <label className="field">Server URL<input value={m.url ?? ''} placeholder="https://example.com/mcp" onChange={(e) => void edit(m.id, { url: e.target.value })} /></label>
                  <label className="field"><span>Headers (<code>Name: value</code> per line) <span className="muted">Stored unencrypted in settings.json. Prefer OAuth where the server supports it.</span></span>
                    <textarea rows={2} defaultValue={headersToText(m.headers)} onBlur={(e) => void edit(m.id, { headers: textToHeaders(e.target.value) })} />
                  </label>
                  <label className="check"><input type="checkbox" checked={!!m.oauth} onChange={(e) => void edit(m.id, { oauth: e.target.checked })} /> Sign in with OAuth when the server asks for it</label>
                  <OAuthControls id={m.id} state={st?.state} enabled={m.oauth} />
                </>
              ) : (
                <>
                  <label className="field">Command<input value={m.command} onChange={(e) => void edit(m.id, { command: e.target.value })} /></label>
                  <label className="field">Arguments (one per line)<textarea rows={2} defaultValue={argsToText(m.args)} onBlur={(e) => void edit(m.id, { args: textToArgs(e.target.value) })} /></label>
                  <label className="field">Environment (KEY=value per line)<textarea rows={2} defaultValue={envToText(m.env)} onBlur={(e) => void edit(m.id, { env: textToEnv(e.target.value) })} /></label>
                </>
              )}
            </div>
          )
        })}
        <div className="row">
          <button onClick={() => void setServers([...s.mcpServers, { id: crypto.randomUUID(), name: 'new-server', command: '', args: [], env: {}, enabled: false }])}>＋ Add local server</button>
          <button onClick={() => void setServers([...s.mcpServers, { id: crypto.randomUUID(), name: 'remote-server', transport: 'http', url: '', headers: {}, oauth: true, command: '', args: [], env: {}, enabled: false }])}>＋ Add remote server</button>
        </div>
        <h4>Import from JSON</h4>
        <p className="muted">Paste a <code>{'{ "mcpServers": { … } }'}</code> block, for example from <code>claude_desktop_config.json</code>.</p>
        <textarea rows={4} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"mcpServers": {"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}}' />
        <div className="row"><button disabled={!importText.trim()} onClick={() => void doImport()}>Import</button></div>
        {note && <p role="status" className="muted">{note}</p>}
      </section>
    </div>
  )
}

function OAuthControls({ id, state, enabled }: { id: string; state?: string; enabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!enabled) return null
  const signIn = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    const r = await window.api.mcp.authorize(id)
    setBusy(false)
    if (!r.ok) setErr(r.error ?? 'Sign-in failed')
  }
  return (
    <div className="row">
      {(state === 'needs-auth' || busy) && <button className="primary" disabled={busy} onClick={() => void signIn()}>{busy ? 'Waiting for the browser…' : 'Sign in'}</button>}
      {state === 'connected' && <button onClick={() => void window.api.mcp.signOut(id)}>Sign out</button>}
      {state === 'needs-auth' && !busy && <span className="muted">This server needs you to sign in.</span>}
      {err && <span className="warnline" role="alert">{err}</span>}
    </div>
  )
}
