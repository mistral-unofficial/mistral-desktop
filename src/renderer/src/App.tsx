import { useState } from 'react'
import { ChatView } from './views/ChatView'
import { CodeView } from './views/CodeView'
import { SettingsView } from './views/SettingsView'

type Tab = 'chat' | 'code' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('chat')
  // Views stay mounted so a running chat or code session survives tab switches.
  return (
    <div className="app">
      <nav className="tabs" role="tablist">
        <span className="brand">Mistral</span>
        {(['chat', 'code', 'settings'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      <main>
        <section hidden={tab !== 'chat'} className="pane"><ChatView active={tab === 'chat'} goSettings={() => setTab('settings')} /></section>
        <section hidden={tab !== 'code'} className="pane"><CodeView active={tab === 'code'} goSettings={() => setTab('settings')} /></section>
        <section hidden={tab !== 'settings'} className="pane"><SettingsView /></section>
      </main>
    </div>
  )
}
