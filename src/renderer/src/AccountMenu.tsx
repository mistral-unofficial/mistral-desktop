import { useEffect, useRef, useState } from 'react'
import type { AccountInfo, SettingsView } from '@shared/types'
import { formatBudget, formatUsage } from './format'

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s)

export function planLabel(a: AccountInfo): string {
  if (!a.plan) return ''
  return [cap(a.plan.name), cap(a.plan.type)].filter(Boolean).join(' · ')
}

/** Sidebar footer: who you are, your plan, and a popover with the budget. */
export function AccountMenu({ settings, onSettings }: { settings?: SettingsView; onSettings: () => void }) {
  const [open, setOpen] = useState(false)
  const [info, setInfo] = useState<AccountInfo>({})
  const [webBusy, setWebBusy] = useState(false)
  const [loaded, setLoaded] = useState(false) // false until the first answer: show nothing instead of a placeholder
  const box = useRef<HTMLDivElement>(null)
  const signedIn = !!settings?.hasApiKey

  useEffect(() => {
    if (!settings) return
    let stale = false
    void window.api.account.get().then((a) => { if (!stale) { setInfo(a); setLoaded(true) } })
    return () => { stale = true }
  }, [settings?.hasApiKey, settings?.apiBase, open])
  useEffect(() => window.api.account.onUpdate((a) => { setInfo(a); setLoaded(true) }), [])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  // The website's own answer wins; the name and email typed in Settings are the fallback.
  const typedName = settings?.profileName.trim()
  const known = signedIn || !!info.webSignedIn
  const name = info.profile?.name || typedName || (known ? 'Mistral account' : 'Not signed in')
  const email = info.profile?.email || settings?.profileEmail.trim()
  const plan = signedIn ? planLabel(info) : ''
  const subtitle = plan || info.profile?.organization || ''
  const ready = !!settings && (loaded || !!typedName)
  const initial = !ready ? '' : info.profile?.name || typedName ? (info.profile?.name || typedName)![0]!.toUpperCase() : known ? 'M' : '?'
  const webSignIn = async (): Promise<void> => { setWebBusy(true); setInfo(await window.api.account.webSignIn()); setWebBusy(false) }
  const settingsLink = (): void => { setOpen(false); onSettings() }

  return (
    <div className="accountbox" ref={box}>
      {open && (
        <div className="popover" role="dialog" aria-label="Account">
          <div className="pophead">
            <span className="avatar big" aria-hidden="true">{initial}</span>
            <div className="popwho"><strong>{name}</strong>{email && <span className="muted">{email}</span>}</div>
          </div>

          {/* Vibe Code: the API key used by the Code and Chat tabs. */}
          <div className="popsection">
            {signedIn ? (
              <div className="poprow"><span>Plan</span><span className="muted">{plan || 'Unavailable'}</span></div>
            ) : (
              <>
                <h4>Vibe Code</h4>
                <p className="muted limitnote">Not signed in. The Code and Chat tabs need an API key.</p>
                <button className="wide" onClick={settingsLink}>Sign in: Vibe Code (Settings)</button>
              </>
            )}
          </div>

          {/* Le Chat: the web account, for name, organisation and budget. */}
          {info.webSignedIn ? (
            <>
              {info.profile?.organization && (
                <div className="popsection"><div className="poprow"><span>Organisation</span><span className="muted">{info.profile.organization}</span></div></div>
              )}
              {info.budget ? (
                <div className="popsection">
                  <h4>Budget</h4>
                  <div className="poprow"><span>Usage</span><span className="muted">{formatUsage(info.budget.usagePercent)}</span></div>
                  <div className="meter" role="meter" aria-label="Usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(info.budget.usagePercent)}><span style={{ width: `${Math.min(100, info.budget.usagePercent)}%` }} /></div>
                  <div className="poprow"><span>Budget</span><span className="muted">{formatBudget(info.budget)}</span></div>
                  {info.budget.resetAt && <div className="poprow"><span>Resets</span><span className="muted">{new Date(info.budget.resetAt).toLocaleDateString()}</span></div>}
                </div>
              ) : (
                <div className="popsection"><p className="muted limitnote">Signed in to Le Chat, but no budget data came back.</p></div>
              )}
            </>
          ) : (
            <div className="popsection">
              <h4>Le Chat</h4>
              <p className="muted limitnote">Sign in to see your name, organisation and budget here.</p>
              <button className="wide" disabled={webBusy} onClick={() => void webSignIn()}>{webBusy ? 'Waiting for the sign-in window…' : 'Sign in: Le Chat'}</button>
            </div>
          )}

          <div className="popsection links">
            {info.webSignedIn && <button className="linklike" onClick={async () => setInfo(await window.api.account.webSignOut())}>Sign out: Le Chat</button>}
            <a href="https://console.mistral.ai/" target="_blank" rel="noreferrer">Manage account and billing ↗</a>
            <button className="linklike" onClick={settingsLink}>Settings</button>
          </div>
        </div>
      )}
      <button className="accountbtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{initial}</span>
        <span className="who"><span className="whoname">{ready ? name : ''}</span>{subtitle && <span className="muted whoplan">{subtitle}</span>}</span>
      </button>
    </div>
  )
}
