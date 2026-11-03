import { BrowserWindow, app, session } from 'electron'
import type { WebAuthWindows } from './code/service'

const PARTITION = 'persist:mistral-web'
const WEB_ORIGIN = 'https://chat.mistral.ai'

/**
 * The app's own Chromium session for chat.mistral.ai, kept apart from everything else the app does. The user signs
 * in once in a visible window (the cookies never leave this partition), and the app then reads account data the
 * same way the website does: with same-origin requests made from inside a real page.
 */
export class WebSession implements WebAuthWindows {
  private reader?: BrowserWindow
  constructor(private parent: () => BrowserWindow | null) {}

  private get ses(): Electron.Session {
    return session.fromPartition(PARTITION)
  }

  /** Embedded login pages commonly reject the "Electron/x" token in the user agent. */
  private userAgent(): string {
    return app.userAgentFallback.replace(/\s*Electron\/\S+/, '')
  }

  private newWindow(show: boolean): BrowserWindow {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      show,
      // A normal window (not a modal sheet), so it has the usual title bar with a close button.
      closable: true,
      minimizable: true,
      title: 'Sign in to Mistral',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    win.webContents.setUserAgent(this.userAgent())
    // Sign-in pages may open provider popups (Google, Microsoft, ...): show them in the same window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void win.loadURL(url)
      return { action: 'deny' }
    })
    return win
  }

  /** Shows a page in a visible window (used for the sign-in). */
  open(url: string): { closed: Promise<void>; close(): void } {
    const win = this.newWindow(true)
    const closed = new Promise<void>((resolve) => win.once('closed', () => resolve()))
    void win.loadURL(url)
    return { closed, close: () => !win.isDestroyed() && win.close() }
  }

  /**
   * Shows the website's sign-in and closes the window by itself once a login session appears (after a short
   * pause so the page can finish). Resolves when the window is gone, whichever way that happened.
   */
  async signInInWindow(url: string): Promise<void> {
    const w = this.open(url)
    let done = false
    void w.closed.then(() => (done = true))
    const timer = setInterval(() => {
      if (done) return
      void this.signedIn().then((ok) => {
        if (ok && !done) {
          done = true
          setTimeout(() => w.close(), 1500)
        }
      })
    }, 1000)
    await w.closed
    clearInterval(timer)
  }

  /** True when the web partition holds a logged-in chat.mistral.ai session. */
  async signedIn(): Promise<boolean> {
    const cookies = await this.ses.cookies.get({ url: WEB_ORIGIN })
    return cookies.some((c) => c.name.startsWith('ory_session'))
  }

  async signOut(): Promise<void> {
    this.reader?.destroy()
    this.reader = undefined
    await this.ses.clearStorageData()
  }

  private async page(): Promise<BrowserWindow> {
    if (this.reader && !this.reader.isDestroyed()) return this.reader
    const win = this.newWindow(false)
    this.reader = win
    await win.loadURL(`${WEB_ORIGIN}/code`)
    return win
  }

  /** Calls a tRPC query of the website (e.g. "billing.budget") and returns its data, or undefined on any failure. */
  async query(procedure: string): Promise<unknown> {
    if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(procedure)) return undefined
    try {
      if (!(await this.signedIn())) return undefined
      const win = await this.page()
      const input = encodeURIComponent(JSON.stringify({ 0: { json: null, meta: { values: ['undefined'], v: 1 } } }))
      const text = (await win.webContents.executeJavaScript(
        `fetch('/api/trpc/${procedure}?batch=1&input=${input}', { credentials: 'include', headers: { 'x-trpc-source': 'nextjs-react' } }).then(r => r.ok ? r.text() : null)`
      )) as string | null
      if (!text) return undefined
      const first = (JSON.parse(text) as { result?: { data?: { json?: unknown } } }[])[0]
      return first?.result?.data?.json ?? first?.result?.data
    } catch {
      return undefined
    }
  }
}
