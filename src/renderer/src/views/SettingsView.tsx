import { useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus, SettingsView as SV } from '@shared/types'
import { argsToText, envToText, parseMcpJson, textToArgs, textToEnv } from '../mcpImport'

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
      setNote(`Imported ${fresh.length} server(s)${servers.length - fresh.length ? `, ${servers.length - fresh.length} already existed` : ''}${skipped.length ? `. Skipped (no command, remote servers are not supported yet): ${skipped.join(', ')}` : ''}.`)
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

      <section>
        <h3>MCP servers (local, stdio)</h3>
        <p className="muted">Servers run on your machine with your permissions. Only add ones you trust. They are available in Chat and are handed to Vibe in the Code tab.</p>
        {s.mcpServers.map((m) => {
          const st = stat(m.id)
          return (
            <div key={m.id} className="mcpcard">
              <div className="row">
                <label className="check"><input type="checkbox" checked={m.enabled} onChange={(e) => void edit(m.id, { enabled: e.target.checked })} /> Enabled</label>
                <input value={m.name} aria-label="Name" onChange={(e) => void edit(m.id, { name: e.target.value })} />
                <span className={`badge ${st?.state ?? ''}`}>{st?.state ?? 'saved'}</span>
                <button onClick={() => void setServers(s.mcpServers.filter((x) => x.id !== m.id))}>Remove</button>
              </div>
              {st?.error && <div className="warnline">{st.error}</div>}
              {st?.state === 'connected' && <div className="muted">Tools: {st.tools.join(', ') || 'none'}</div>}
              <label className="field">Command<input value={m.command} onChange={(e) => void edit(m.id, { command: e.target.value })} /></label>
              <label className="field">Arguments (one per line)<textarea rows={2} defaultValue={argsToText(m.args)} onBlur={(e) => void edit(m.id, { args: textToArgs(e.target.value) })} /></label>
              <label className="field">Environment (KEY=value per line)<textarea rows={2} defaultValue={envToText(m.env)} onBlur={(e) => void edit(m.id, { env: textToEnv(e.target.value) })} /></label>
            </div>
          )
        })}
        <button onClick={() => void setServers([...s.mcpServers, { id: crypto.randomUUID(), name: 'new-server', command: '', args: [], env: {}, enabled: false }])}>＋ Add server</button>
        <h4>Import from JSON</h4>
        <p className="muted">Paste a <code>{'{ "mcpServers": { … } }'}</code> block, for example from <code>claude_desktop_config.json</code>.</p>
        <textarea rows={4} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"mcpServers": {"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]}}}' />
        <div className="row"><button disabled={!importText.trim()} onClick={() => void doImport()}>Import</button></div>
        {note && <p role="status" className="muted">{note}</p>}
      </section>
    </div>
  )
}
