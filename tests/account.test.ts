import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountService, parseBudget, parseSession } from '../src/main/account'
import { currencySymbol, formatBudget, formatUsage } from '../src/renderer/src/format'

const sample = { usage_percentage: 5.125089, initial_budget: 8.5, currency: 'EUR', reset_at: '2026-12-01T00:00:00Z', payg_enabled: false }

describe('account', () => {
  it('parses the billing.budget response and ignores unrelated fields', () => {
    expect(parseBudget(sample)).toEqual({ usagePercent: 5.125089, initialBudget: 8.5, currency: 'EUR', resetAt: '2026-12-01T00:00:00Z' })
    expect(parseBudget({ initial_budget: 1 })).toBeUndefined()
    expect(parseBudget(null)).toBeUndefined()
    expect(parseBudget({ usage_percentage: 1, initial_budget: 2 })?.currency).toBe('EUR')
  })

  it('parses the user and organisation names from user.session', () => {
    const session = { id: 's', user: { name: 'Wolf', email: 'w@example.com', firstName: 'W' }, organization: { name: 'Acme', featureFlags: { a: true } }, workspace: { name: 'Default' } }
    expect(parseSession(session)).toEqual({ name: 'Wolf', email: 'w@example.com', organization: 'Acme' })
    expect(parseSession({ user: { name: '  ' }, organization: {} })).toBeUndefined()
    expect(parseSession(null)).toBeUndefined()
  })

  it('reads the plan from whoami and the budget from the web session', async () => {
    const f = (async () => Response.json({ plan_name: 'FREE', plan_type: 'CHAT', customer_id: 'x' })) as unknown as typeof fetch
    const web = { signedIn: async () => true, query: async (p: string) => (p === 'billing.budget' ? sample : p === 'user.session' ? { user: { name: 'Wolf' }, organization: { name: 'Acme' } } : undefined) }
    const info = await new AccountService(f, web).get('k')
    expect(info.plan).toEqual({ name: 'FREE', type: 'CHAT' })
    expect(info.webSignedIn).toBe(true)
    expect(info.budget?.initialBudget).toBe(8.5)
    expect(info.profile).toEqual({ name: 'Wolf', email: undefined, organization: 'Acme' })
    expect(await new AccountService(f, web).get(undefined)).toEqual({})
  })

  it('has no budget without a web session', async () => {
    const a = new AccountService((async () => Response.json({})) as unknown as typeof fetch, { signedIn: async () => false, query: async () => sample })
    const info = await a.get('k')
    expect(info.webSignedIn).toBe(false)
    expect(info.budget).toBeUndefined()
    expect(info.profile).toBeUndefined()
  })

  it('never sends the key to Mistral when a custom API base is used', async () => {
    const urls: string[] = []
    const a = new AccountService((async (u: string) => (urls.push(u), Response.json({}))) as unknown as typeof fetch)
    expect((await a.get('k', 'http://localhost:8080/v1')).plan).toBeUndefined()
    expect(urls).toEqual([])
  })
})

describe('account cache and refresh', () => {
  const whoami = (async () => Response.json({ plan_name: 'FREE', plan_type: 'CHAT' })) as unknown as typeof fetch
  const web = (name: string, delayMs = 0) => ({
    signedIn: async () => true,
    query: async (p: string) => {
      await new Promise((r) => setTimeout(r, delayMs))
      return p === 'user.session' ? { user: { name } } : p === 'billing.budget' ? sample : undefined
    }
  })

  it('answers at once from the remembered result, then refreshes in the background', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'md-acc-')), 'account-cache.json')
    const first = new AccountService(whoami, web('Wolf'), file)
    expect((await first.get('k')).profile?.name).toBe('Wolf') // nothing known yet: waits for the real answer

    const updates: (string | undefined)[] = []
    const second = new AccountService(whoami, web('Wolf (new)', 60), file, (i) => updates.push(i.profile?.name)) // a new run, same file
    expect(second.cached()?.profile?.name).toBe('Wolf') // known before any network call
    const t0 = Date.now()
    expect((await second.get('k')).profile?.name).toBe('Wolf') // instant, from the cache
    expect(Date.now() - t0).toBeLessThan(50)
    await second.refresh('k') // joins the refresh that get() started
    expect(updates).toEqual(['Wolf (new)'])
    expect(second.cached()?.profile?.name).toBe('Wolf (new)')
  })

  it('shares one in-flight refresh between callers and forgets everything on clear', async () => {
    let calls = 0
    const counting = { signedIn: async () => true, query: async (p: string) => (calls++, p === 'user.session' ? { user: { name: 'W' } } : undefined) }
    const a = new AccountService(whoami, counting)
    await Promise.all([a.refresh('k'), a.refresh('k'), a.refresh('k')])
    expect(calls).toBe(2) // one budget and one session query, not three of each
    a.clear()
    expect(a.cached()).toBeUndefined()
    expect(await a.refresh(undefined)).toEqual({})
  })
})

describe('budget formatting', () => {
  const b = parseBudget(sample)!
  it('computes the spend from the percentage and always shows two decimals', () => {
    expect(formatBudget(b, 'de-DE')).toBe('0,44 / 8,50 €')
    expect(formatBudget({ ...b, usagePercent: 0 }, 'de-DE')).toBe('0,00 / 8,50 €')
    expect(formatBudget({ ...b, usagePercent: 100, initialBudget: 10 }, 'de-DE')).toBe('10,00 / 10,00 €')
    expect(formatBudget(b, 'en-US')).toBe('0.44 / 8.50 €'.replace('€', '€'))
  })
  it('formats usage as a whole percent', () => {
    expect(formatUsage(5.125089)).toBe('5%')
    expect(formatUsage(0)).toBe('0%')
    expect(formatUsage(0.3)).toBe('<1%')
    expect(formatUsage(100)).toBe('100%')
  })
  it('knows the currency symbol', () => {
    expect(currencySymbol('EUR', 'de-DE')).toBe('€')
    expect(currencySymbol('USD', 'en-US')).toBe('$')
  })
})
