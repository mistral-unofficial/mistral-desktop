// Mock of the Mistral chat API for e2e: GET /v1/models, POST /v1/chat/completions (streaming, one tool call when asked).
import http from 'node:http'
const port = Number(process.env.MOCK_MISTRAL_PORT || 8798)
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n')
http.createServer((req, res) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'mock-large', capabilities: { completion_chat: true } }, { id: 'mock-embed', capabilities: { completion_chat: false } }] }))
  }
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthorized"}') }
    const j = JSON.parse(body)
    const last = j.messages.at(-1)
    const tool = (j.tools || []).find((t) => /echo/.test(t.function.name))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: j.model }
    if (last.role === 'user' && /echo/.test(last.content) && tool) {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Calling the tool. ' } }] })
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: tool.function.name, arguments: '{"text":"ping"}' } }] } }] })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else if (last.role === 'tool') {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: 'The tool said: ' + last.content } }] })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    } else {
      for (const w of ['Hello ', 'from ', 'mock ', 'Mistral.', '\n\n```js\nconsole.log(1)\n```']) sse(res, { ...base, choices: [{ index: 0, delta: { content: w } }] })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    res.end('data: [DONE]\n\n')
  })
}).listen(port, '127.0.0.1', () => console.error('[mock-mistral] up on', port))
