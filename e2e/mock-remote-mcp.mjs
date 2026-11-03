// Mock remote MCP server for tests and e2e.
// modes: 'open' (no auth), 'bearer' (static token), 'oauth' (OAuth 2.1: discovery, dynamic registration, PKCE, refresh), 'sse' (legacy HTTP+SSE transport, no auth)
import crypto from 'node:crypto'
import http from 'node:http'

export function startMockRemote({ port = 0, mode = 'open', bearer = 'static-token' } = {}) {
  const stats = { registrations: 0, authorizes: 0, tokens: 0, refreshes: 0, mcp: 0 }
  const validTokens = new Set()
  const codes = new Map()
  const sseClients = new Map()
  let base = ''

  const rpc = (m) => {
    if (m.method === 'initialize') return { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock-remote', version: '1' } }
    if (m.method === 'tools/list') return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
    if (m.method === 'tools/call') return { content: [{ type: 'text', text: 'REMOTE:' + (m.params.arguments?.text ?? '') }] }
    return {}
  }
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)) })
  const authorized = (req) => {
    const h = req.headers.authorization || ''
    if (mode === 'bearer') return h === `Bearer ${bearer}`
    if (mode === 'oauth') return h.startsWith('Bearer ') && validTokens.has(h.slice(7))
    return true
  }
  const unauthorized = (res) => json(res, 401, { error: 'unauthorized' }, mode === 'oauth' ? { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } : {})

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, base || 'http://127.0.0.1')
    const p = u.pathname
    if (mode === 'oauth') {
      if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
      if (p.startsWith('/.well-known/oauth-authorization-server')) return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
      if (p === '/register' && req.method === 'POST') {
        stats.registrations++
        const body = JSON.parse(await readBody(req))
        return json(res, 201, { ...body, client_id: 'client-' + stats.registrations })
      }
      if (p === '/authorize') {
        stats.authorizes++
        const code = crypto.randomBytes(8).toString('hex')
        codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') })
        const to = new URL(u.searchParams.get('redirect_uri'))
        to.searchParams.set('code', code)
        to.searchParams.set('state', u.searchParams.get('state'))
        res.writeHead(302, { location: to.toString() }); return res.end()
      }
      if (p === '/token' && req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req))
        const issue = () => { const t = 'tok-' + crypto.randomBytes(6).toString('hex'); validTokens.add(t); return t }
        if (f.get('grant_type') === 'authorization_code') {
          const c = codes.get(f.get('code'))
          const ok = c && crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge && f.get('redirect_uri') === c.redirect
          if (!ok) return json(res, 400, { error: 'invalid_grant' })
          codes.delete(f.get('code')); stats.tokens++
          return json(res, 200, { access_token: issue(), token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
        }
        if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'refresh-1') {
          stats.refreshes++
          return json(res, 200, { access_token: issue(), token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
        }
        return json(res, 400, { error: 'invalid_grant' })
      }
    }

    if (mode === 'sse') {
      if (p === '/mcp' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const sid = crypto.randomBytes(4).toString('hex'); sseClients.set(sid, res)
        res.write(`event: endpoint\ndata: /messages?sessionId=${sid}\n\n`)
        req.on('close', () => sseClients.delete(sid)); return
      }
      if (p === '/messages' && req.method === 'POST') {
        const stream = sseClients.get(u.searchParams.get('sessionId'))
        const m = JSON.parse(await readBody(req))
        res.writeHead(202).end('Accepted')
        if (m.id !== undefined && stream) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: rpc(m) })}\n\n`)
        return
      }
      return json(res, 405, { error: 'method not allowed' }) // POST /mcp: forces the client's SSE fallback
    }

    if (p === '/mcp') {
      stats.mcp++
      if (!authorized(req)) return unauthorized(res)
      if (req.method === 'POST') {
        const m = JSON.parse(await readBody(req))
        if (m.id === undefined) { res.writeHead(202).end(); return }
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result: rpc(m) })
      }
      if (req.method === 'DELETE') { res.writeHead(200).end(); return }
      return json(res, 405, { error: 'no server-initiated stream' })
    }
    json(res, 404, { error: 'not found' })
  })

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port
    base = `http://127.0.0.1:${actual}`
    resolve({
      url: `${base}/mcp`, port: actual, stats,
      /** Invalidate all issued access tokens (refresh tokens keep working). */
      expireTokens: () => validTokens.clear(),
      close: () => new Promise((r) => { for (const c of sseClients.values()) c.end(); server.closeAllConnections?.(); server.close(() => r()) })
    })
  }))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const mode = process.env.MOCK_REMOTE_MODE || 'open'
  const s = await startMockRemote({ port: Number(process.env.MOCK_REMOTE_PORT || 8797), mode })
  console.error(`[mock-remote] ${mode} on ${s.url}`)
}
