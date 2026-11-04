import { useEffect, useState } from 'react'
import type { AccountInfo, McpServerConfig, McpServerStatus, SettingsView as SV } from '@shared/types'
import { argsToText, envToText, headersToText, parseMcpJson, textToArgs, textToEnv, textToHeaders } from '../mcpImport'
import { SETTINGS_SECTIONS, type SettingsSection } from '../settingsSections'
import { ExtensionsSection } from './ExtensionsSection'

export function SettingsView({ section, onSection }: { section: SettingsSection; onSection: (s: SettingsSection) => void }) {
  const [s, setS] = useState<SV>()
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<McpServerStatus[]>([])
  const [importText, setImportText] = useState('')
  const [note, setNote] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState('')
  const [signInOk, setSignInOk] = useState(false)
  const [account, setAccount] = useState<AccountInfo>({})
  const [chatBusy, setChatBusy] = useState(false)

  useEffect(() => {
    void window.api.settings.get().then(setS)
    void window.api.mcp.status().then(setStatus)
    void window.api.account.get().then(setAccount)
    const offAccount = window.api.account.onUpdate(setAccount)
    const offMcp = window.api.mcp.onChange(setStatus)
    return () => { offAccount(); offMcp() }
  }, [])
  if (!s) return <div className="center muted">Loading…</div>

  const patch = async (p: Partial<SV>): Promise<void> => setS(await window.api.settings.update(p))
  const setServers = (servers: McpServerConfig[]): Promise<void> => patch({ mcpServers: servers })
  const edit = (id: string, p: Partial<McpServerConfig>): Promise<void> => setServers(s.mcpServers.map((m) => (m.id === id ? { ...m, ...p } : m)))
  const stat = (id: string): McpServerStatus | undefined => status.find((x) => x.id === id)

  // "Sign in: Vibe Code": creates the API key used by Code and Chat.
  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setSignInError('')
    setSignInOk(false)
    const r = await window.api.settings.signInWithBrowser()
    if (r.ok) setSignInOk(true)
    else setSignInError(r.error)
    setS(await window.api.settings.get())
    setSigningIn(false)
  }
  // "Sign in: Le Chat": your Le Chat web account, for name, organisation and budget.
  const signInChat = async (): Promise<void> => {
    setChatBusy(true)
    setAccount(await window.api.account.webSignIn())
    setChatBusy(false)
  }

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

  const label = SETTINGS_SECTIONS.find((x) => x.id === section)?.label ?? ''
  return (
    <>
      <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
        <h2>Settings</h2>
        {SETTINGS_SECTIONS.map((x) => (
          <button key={x.id} id={`settings-tab-${x.id}`} role="tab" aria-selected={section === x.id} aria-controls="settings-panel" className={section === x.id ? 'snavitem active' : 'snavitem'} onClick={() => onSection(x.id)}>{x.label}</button>
        ))}
      </nav>
      <div className="settings" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>
        <h2>{label}</h2>

        {section === 'account' && (
          <>
      <section>
        <h3>Le Chat</h3>
        <p className="muted">Your Le Chat web account. Shows your name, organisation and budget in the sidebar. It does not give the app access to the Mistral API; that is what Vibe Code below is for.</p>
        <div className="row">
          {account.webSignedIn ? (
            <>
              <span className="okline">✓ Signed in{account.profile?.name ? ` as ${account.profile.name}` : ''}{account.profile?.organization ? ` · ${account.profile.organization}` : ''}</span>
              <button onClick={async () => setAccount(await window.api.account.webSignOut())}>Sign out: Le Chat</button>
            </>
          ) : (
            <>
              <button className="primary" disabled={chatBusy} onClick={() => void signInChat()}>{chatBusy ? 'Waiting for the sign-in window…' : 'Sign in: Le Chat'}</button>
              <span className="muted">Opens chat.mistral.ai in a window of this app.</span>
            </>
          )}
        </div>
      </section>

      <section>
        <h3>Vibe Code</h3>
        <p className="muted">Creates a Mistral API key for your workspace. The Code tab (Vibe) and the Chat tab both use it. Or paste a key you made at console.mistral.ai. {s.hasApiKey ? '✓ A key is set.' : 'No key set.'}</p>
        {s.insecureKeyStorage && <p className="warnline">No OS keychain available: the key is stored in a file readable only by your user.</p>}
        <div className="row">
          <button className="primary" disabled={signingIn} onClick={() => void signIn()}>{signingIn ? 'Waiting for the sign-in window…' : 'Sign in: Vibe Code'}</button>
          {s.hasApiKey && <button title="Removes the API key kept by this app. Le Chat stays signed in, and so does Vibe's own stored sign-in." onClick={async () => { setSignInOk(false); setS(await window.api.settings.signOut()) }}>Sign out: Vibe Code</button>}
          <span className="muted">Needs Vibe installed.</span>
        </div>
        {signInError && <p className="warnline">{signInError}</p>}
        {signInOk && !signingIn && <p className="okline" role="status">✓ Signed in. The Code and Chat tabs now use your key.</p>}
        <div className="row">
          <input type="password" autoComplete="off" value={key} placeholder={s.hasApiKey ? '•••••••• (enter a new key to replace)' : 'Or paste an API key'} onChange={(e) => setKey(e.target.value)} />
          <button disabled={!key.trim()} onClick={async () => { setS(await window.api.settings.setApiKey(key)); setKey('') }}>Save</button>
        </div>
        <p className="muted">Both sign-ins use the same Mistral login, so if you are signed in to one, the other may finish without asking again.</p>
      </section>

      <section>
        <h3>Vibe setup</h3>
        <p className="muted">The Code tab runs Mistral Vibe on this computer.</p>
        <label className="field"><span>Path to <code>vibe-acp</code> <span className="muted">(empty = auto-detect)</span></span><input value={s.vibePath} placeholder="vibe-acp" onChange={(e) => void patch({ vibePath: e.target.value })} /></label>
        <label className="field"><span>Vibe home <span className="muted">(optional, isolates Vibe's config and sessions)</span></span><input value={s.vibeHome} onChange={(e) => void patch({ vibeHome: e.target.value })} /></label>
        <p className="muted">Install Vibe with <code>uv tool install mistral-vibe</code>.</p>
      </section>
          </>
        )}

        {section === 'connectors' && (
          <>
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
          </>
        )}

        {section === 'general' && (
          <>
      <section>
        <h3>Profile</h3>
        <p className="muted">Your name, email and organisation come from your Mistral web account once you are signed in there. Enter them here only as a fallback for when you are not. It stays on this computer.</p>
        <label className="field">Name<input value={s.profileName} onChange={(e) => void patch({ profileName: e.target.value })} /></label>
        <label className="field">Email<input type="email" value={s.profileEmail} onChange={(e) => void patch({ profileEmail: e.target.value })} /></label>
      </section>

      <section>
        <h3>Chat</h3>
        <label className="field">Default model<input value={s.model} onChange={(e) => void patch({ model: e.target.value })} /></label>
        <label className="field">API base URL<input value={s.apiBase} onChange={(e) => void patch({ apiBase: e.target.value })} /></label>
      </section>
          </>
        )}
      </div>
    </>
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
