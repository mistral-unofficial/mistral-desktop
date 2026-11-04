import { useCallback, useEffect, useState } from 'react'
import type { SettingsView as SV } from '@shared/types'
import { ChatView } from './views/ChatView'
import { CodeView } from './views/CodeView'
import { SettingsView } from './views/SettingsView'
import type { SettingsSection } from './settingsSections'
import { AccountMenu } from './AccountMenu'
import { SidebarSlots, type SidebarTab } from './sidebar'

const OPEN_KEY = 'sidebar-open'
const readOpen = (): boolean => {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export function App() {
  const [tab, setTab] = useState<SidebarTab>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('account')
  /** Opens Settings, on the given section (Account by default). */
  const openSettings = (section: SettingsSection = 'account'): void => {
    setSettingsSection(section)
    setShowSettings(true)
  }
  const [open, setOpen] = useState(readOpen)
  const [slots, setSlots] = useState<Partial<Record<SidebarTab, HTMLElement | null>>>({})
  const [settings, setSettings] = useState<SV>()

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      /* not persisted */
    }
  }, [open])
  // Re-read the account state whenever Settings is left: that is where keys are added or removed.
  useEffect(() => {
    if (!showSettings) void window.api.settings.get().then(setSettings)
  }, [showSettings])

  const pick = (t: SidebarTab): void => setTab(t)
  // Cmd+, (Ctrl+, elsewhere) comes from the app menu.
  useEffect(() => window.api.app.onOpenSettings(() => openSettings()), [])
  useEffect(() => {
    if (!showSettings) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShowSettings(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings])
  // Stable callbacks: a new ref function each render would be detached and re-attached forever.
  const chatSlot = useCallback((el: HTMLElement | null): void => {
    if (el) setSlots((s) => (s.chat === el ? s : { ...s, chat: el }))
  }, [])
  const codeSlot = useCallback((el: HTMLElement | null): void => {
    if (el) setSlots((s) => (s.code === el ? s : { ...s, code: el }))
  }, [])
  const mac = navigator.platform.toLowerCase().includes('mac')

  // Views stay mounted so a running chat or code session survives tab switches.
  return (
    <div className={`app${mac ? ' mac' : ''}`}>
      <header className="toolbar">
        <button className="iconbtn toggle" aria-label={open ? 'Hide sidebar' : 'Show sidebar'} aria-expanded={open} title={open ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setOpen(!open)}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="2" y="3" width="14" height="12" rx="2.5" />
            <path d="M7 3v12" />
          </svg>
        </button>
      </header>
      <div className="body">
        <aside className="appsidebar" hidden={!open}>
          <div className="segtabs" role="tablist">
            {(['chat', 'code'] as SidebarTab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'seg active' : 'seg'} onClick={() => pick(t)}>
                {t === 'chat' ? 'Chat' : 'Code'}
              </button>
            ))}
          </div>
          <div className="slot" hidden={tab !== 'chat'} ref={chatSlot} />
          <div className="slot" hidden={tab !== 'code'} ref={codeSlot} />
          <footer className="sidefoot">
            <AccountMenu settings={settings} onSettings={() => openSettings()} />
            <button className={showSettings ? 'iconbtn cog active' : 'iconbtn cog'} aria-label="Settings" aria-haspopup="dialog" title="Settings" onClick={() => openSettings()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </footer>
        </aside>
        <SidebarSlots.Provider value={slots}>
          <main>
            <section hidden={tab !== 'chat'} className="pane"><ChatView active={tab === 'chat' && !showSettings} goSettings={openSettings} /></section>
            <section hidden={tab !== 'code'} className="pane"><CodeView active={tab === 'code' && !showSettings} goSettings={openSettings} /></section>
          </main>
        </SidebarSlots.Provider>
      </div>
      {showSettings && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowSettings(false) }}>
          <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
            <button className="iconbtn close" aria-label="Close settings" title="Close (Esc)" onClick={() => setShowSettings(false)}>✕</button>
            <SettingsView section={settingsSection} onSection={setSettingsSection} />
          </div>
        </div>
      )}
    </div>
  )
}
