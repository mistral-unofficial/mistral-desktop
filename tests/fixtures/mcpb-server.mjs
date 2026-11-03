// MCP server used inside test .mcpb bundles. Reports configuration it received so tests can check substitution.
import readline from 'node:readline'
const w = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') w({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bundled', version: '1' } } })
  else if (m.method === 'tools/list') w({ id: m.id, result: { tools: [{ name: 'info', description: 'Report config', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') w({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ greeting: process.env.GREETING, secret: process.env.SECRET, args: process.argv.slice(2), cwd: process.cwd() }) }] } })
  else if (m.id !== undefined) w({ id: m.id, result: {} })
})
