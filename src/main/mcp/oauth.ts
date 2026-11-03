import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SecretVault } from '../vault'

interface Stored {
  clientInformation?: OAuthClientInformationMixed
  /** The redirect URL the client registration is valid for. */
  registeredRedirect?: string
  tokens?: OAuthTokens
  codeVerifier?: string
  /** Port used last time, so a saved dynamic client registration can be reused. */
  port?: number
}

export const oauthKey = (serverId: string): string => `oauth:${serverId}`

export class OAuthStore {
  constructor(private vault: SecretVault) {}
  get(id: string): Stored {
    return this.vault.get<Stored>(oauthKey(id)) ?? {}
  }
  update(id: string, patch: Partial<Stored>): void {
    this.vault.set(oauthKey(id), { ...this.get(id), ...patch })
  }
  clear(id: string): void {
    this.vault.delete(oauthKey(id))
  }
  accessToken(id: string): string | undefined {
    return this.get(id).tokens?.access_token
  }
}

export interface CallbackServer {
  redirectUrl: string
  port: number
  /** Resolves with the authorization code once the browser is redirected back. */
  waitForCode(timeoutMs: number): Promise<string>
  setExpectedState(state: string): void
  close(): void
}

const PAGE = (msg: string): string => `<!doctype html><meta charset="utf-8"><title>Mistral Desktop</title><body style="font:16px system-ui;margin:3em"><h2>${msg}</h2><p>You can close this tab and return to the app.</p></body>`

/** One-shot loopback HTTP server that receives the OAuth redirect. Binds 127.0.0.1 only. */
export async function startCallbackServer(preferredPort?: number): Promise<CallbackServer> {
  let expected: string | undefined
  let settle: { resolve: (c: string) => void; reject: (e: Error) => void } | undefined
  let early: { code?: string; error?: Error } | undefined
  const deliver = (r: { code?: string; error?: Error }): void => {
    if (settle) r.code ? settle.resolve(r.code) : settle.reject(r.error!)
    else early ??= r
  }
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    const state = u.searchParams.get('state')
    if (err) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE('Sign-in was cancelled'))
      return deliver({ error: new Error(`Authorization failed: ${err}${u.searchParams.get('error_description') ? ` (${u.searchParams.get('error_description')})` : ''}`) })
    }
    if (!code || !expected || state !== expected) {
      res.writeHead(400, { 'content-type': 'text/html' }).end(PAGE('Invalid sign-in response'))
      return // ignore: could be a stray or forged request; keep waiting for the real one
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE('Signed in'))
    deliver({ code })
  })
  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => (server.off('error', reject), resolve()))
    })
  try {
    await listen(preferredPort ?? 0)
  } catch {
    await listen(0)
  }
  const port = (server.address() as AddressInfo).port
  return {
    port,
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    setExpectedState: (s) => (expected = s),
    waitForCode: (timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timed out waiting for sign-in in the browser')), timeoutMs)
        settle = { resolve: (c) => (clearTimeout(t), resolve(c)), reject: (e) => (clearTimeout(t), reject(e)) }
        if (early) deliver(early)
      }),
    close: () => void server.close()
  }
}

export interface ProviderOptions {
  redirectUrl: string
  /** When false, starting an authorization only records that sign-in is needed; no browser is opened. */
  interactive: boolean
  openExternal?: (url: string) => void | Promise<void>
  onState?: (state: string) => void
}

export class McpOAuthProvider implements OAuthClientProvider {
  pendingAuthUrl?: URL
  private stateValue?: string
  constructor(
    private serverId: string,
    private store: OAuthStore,
    private opts: ProviderOptions
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Mistral Desktop',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }
  state(): string {
    this.stateValue = randomBytes(24).toString('base64url')
    this.opts.onState?.(this.stateValue)
    return this.stateValue
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const s = this.store.get(this.serverId)
    // A registration is only valid for the redirect URL it was made with.
    return s.registeredRedirect === this.opts.redirectUrl ? s.clientInformation : undefined
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.store.update(this.serverId, { clientInformation: info, registeredRedirect: this.opts.redirectUrl })
  }
  tokens(): OAuthTokens | undefined {
    return this.store.get(this.serverId).tokens
  }
  saveTokens(tokens: OAuthTokens): void {
    this.store.update(this.serverId, { tokens })
  }
  saveCodeVerifier(v: string): void {
    this.store.update(this.serverId, { codeVerifier: v })
  }
  codeVerifier(): string {
    const v = this.store.get(this.serverId).codeVerifier
    if (!v) throw new Error('No code verifier saved')
    return v
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    this.pendingAuthUrl = url
    if (!this.opts.interactive) return
    if (!/^https?:$/.test(url.protocol)) throw new Error('Refusing to open a non-http authorization URL')
    await this.opts.openExternal?.(url.toString())
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const patch: Partial<Stored> = {}
    if (scope === 'all' || scope === 'client') Object.assign(patch, { clientInformation: undefined, registeredRedirect: undefined })
    if (scope === 'all' || scope === 'tokens') patch.tokens = undefined
    if (scope === 'all' || scope === 'verifier') patch.codeVerifier = undefined
    this.store.update(this.serverId, patch)
  }
}
