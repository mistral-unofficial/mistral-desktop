import { zipSync, strToU8 } from 'fflate'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const SERVER_JS = readFileSync(resolve('tests/fixtures/mcpb-server.mjs'))

export function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: '0.2',
    name: 'demo-ext',
    display_name: 'Demo Extension',
    version: '1.0.0',
    description: 'A demo',
    author: { name: 'Tester' },
    server: { type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '${user_config.folder}'], env: { GREETING: '${user_config.greeting}', SECRET: '${user_config.api_key}' } } },
    tools: [{ name: 'info', description: 'Report config' }],
    user_config: {
      greeting: { type: 'string', title: 'Greeting', description: 'Say what', default: 'hello' },
      api_key: { type: 'string', title: 'API key', description: 'Secret', sensitive: true, required: true },
      folder: { type: 'directory', title: 'Folder', description: 'Where', default: '${HOME}/docs' }
    },
    ...over
  }
}

export function makeBundle(opts: { manifest?: Record<string, unknown> | string; files?: Record<string, Uint8Array | string>; signature?: boolean } = {}): Uint8Array {
  const m = opts.manifest ?? manifest()
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(typeof m === 'string' ? m : JSON.stringify(m)),
    'server/index.js': new Uint8Array(SERVER_JS)
  }
  for (const [k, v] of Object.entries(opts.files ?? {})) entries[k] = typeof v === 'string' ? strToU8(v) : v
  const zip = zipSync(entries)
  if (!opts.signature) return zip
  return Buffer.concat([Buffer.from(zip), Buffer.from('MCPB_SIG_V1'), Buffer.from([4, 0, 0, 0]), Buffer.from('SIGN'), Buffer.from('MCPB_SIG_END')])
}
