import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccountBudget, AccountInfo, AccountProfile } from '../shared/types'

/** Vibe's own account lookup (undocumented, so every field is treated as optional). */
const WHOAMI_URL = 'https://console.mistral.ai/api/vibe/whoami'
const PLAN_TTL_MS = 10 * 60_000

/** Reads website account data from a logged-in page. Implemented by WebSession; a stub in tests. */
export interface WebQuery {
  signedIn(): Promise<boolean>
  query(procedure: string): Promise<unknown>
}

/** `billing.budget` answers {usage_percentage, initial_budget, currency, reset_at, payg_enabled}. */
export function parseBudget(data: unknown): AccountBudget | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  if (typeof d.usage_percentage !== 'number' || typeof d.initial_budget !== 'number') return undefined
  return {
    usagePercent: d.usage_percentage,
    initialBudget: d.initial_budget,
    currency: typeof d.currency === 'string' ? d.currency : 'EUR',
    resetAt: typeof d.reset_at === 'string' ? d.reset_at : undefined
  }
}

/** `user.session` answers {user: {name, email, ...}, organization: {name, ...}, ...}; only these fields are used. */
export function parseSession(data: unknown): AccountProfile | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as { user?: { name?: unknown; email?: unknown }; organization?: { name?: unknown } }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const p: AccountProfile = { name: str(d.user?.name), email: str(d.user?.email), organization: str(d.organization?.name) }
  return p.name || p.email || p.organization ? p : undefined
}

export class AccountService {
  private plan?: { value: AccountInfo['plan']; at: number; key: string }
  private cache?: AccountInfo
  private inflight?: Promise<AccountInfo>

  /**
   * `cacheFile` keeps the last answer between runs so the sidebar can show your name straight away while a fresh
   * one loads; `onUpdate` is called with each fresh answer. Both are optional.
   */
  constructor(
    private fetchImpl: typeof fetch = fetch,
    private web?: WebQuery,
    private cacheFile?: string,
    private onUpdate?: (info: AccountInfo) => void
  ) {
    try {
      if (cacheFile && existsSync(cacheFile)) this.cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as AccountInfo
    } catch {
      /* unreadable cache: start empty */
    }
  }

  /** The last known answer (from this run or the previous one), if any. */
  cached(): AccountInfo | undefined {
    return this.cache
  }

  /** Forgets everything remembered about the account (sign-out). */
  clear(): void {
    this.cache = undefined
    this.plan = undefined
    try {
      if (this.cacheFile) unlinkSync(this.cacheFile)
    } catch {
      /* nothing stored */
    }
  }

  private store(info: AccountInfo): void {
    this.cache = info
    try {
      if (this.cacheFile) {
        mkdirSync(dirname(this.cacheFile), { recursive: true })
        writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify(info), { mode: 0o600 })
        renameSync(`${this.cacheFile}.tmp`, this.cacheFile)
      }
    } catch {
      /* the cache is only a convenience */
    }
    this.onUpdate?.(info)
  }

  private async fetchPlan(key: string): Promise<AccountInfo['plan']> {
    if (this.plan && this.plan.key === key && Date.now() - this.plan.at < PLAN_TTL_MS) return this.plan.value
    let value: AccountInfo['plan']
    try {
      const res = await this.fetchImpl(WHOAMI_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const j = (await res.json()) as { plan_name?: unknown; plan_type?: unknown }
        if (typeof j.plan_name === 'string' || typeof j.plan_type === 'string') value = { name: String(j.plan_name ?? ''), type: String(j.plan_type ?? '') }
      }
    } catch {
      /* offline or endpoint changed: no plan shown */
    }
    this.plan = { value, at: Date.now(), key }
    return value
  }

  private async fetchWeb(): Promise<Pick<AccountInfo, 'webSignedIn' | 'budget' | 'profile'>> {
    const web = this.web
    if (!web) return {}
    const webSignedIn = await web.signedIn()
    if (!webSignedIn) return { webSignedIn }
    const [budget, session] = await Promise.all([web.query('billing.budget'), web.query('user.session')])
    return { webSignedIn, budget: parseBudget(budget), profile: parseSession(session) }
  }

  /**
   * Fetches the plan and the web account data (in parallel), remembers the result and reports it through
   * `onUpdate`. Calls made while one is running share it. The key is only sent to Mistral's own console, never to
   * a custom API base URL.
   */
  refresh(key: string | undefined, apiBase = 'https://api.mistral.ai/v1'): Promise<AccountInfo> {
    if (!key) {
      this.clear()
      return Promise.resolve({})
    }
    this.inflight ??= this.load(key, apiBase).finally(() => (this.inflight = undefined))
    return this.inflight
  }

  private async load(key: string, apiBase: string): Promise<AccountInfo> {
    const official = (() => {
      try {
        const h = new URL(apiBase).hostname
        return h === 'mistral.ai' || h.endsWith('.mistral.ai')
      } catch {
        return false
      }
    })()
    const [plan, web] = await Promise.all([official ? this.fetchPlan(key) : Promise.resolve(undefined), this.fetchWeb()])
    const info: AccountInfo = { plan, ...web }
    this.store(info)
    return info
  }

  /** Answers at once from what is remembered and refreshes in the background; waits only when nothing is known. */
  get(key: string | undefined, apiBase?: string): Promise<AccountInfo> {
    if (!key) return this.refresh(undefined)
    const known = this.cache
    const fresh = this.refresh(key, apiBase)
    return known ? Promise.resolve(known) : fresh
  }
}
