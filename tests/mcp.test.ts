import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { McpHost, toAcpServers, wireName } from '../src/main/mcp/host'
import type { McpServerConfig } from '../src/shared/types'

const cfg = (o: Partial<McpServerConfig> = {}): McpServerConfig => ({ id: 'a', name: 'My Server!', command: process.execPath, args: [resolve('tests/fixtures/mini-mcp.mjs')], env: {}, enabled: true, ...o })

describe('wireName', () => {
  it('sanitises to the characters Mistral accepts and caps at 64', () => {
    expect(wireName('My Server!', 'do.thing')).toBe('My_Server___do_thing')
    expect(wireName('s'.repeat(80), 't')).toHaveLength(64)
  })
})

describe('McpHost', () => {
  it('connects to a stdio server, lists and calls its tools', async () => {
    const h = new McpHost()
    await h.sync([cfg()])
    expect(h.status()).toMatchObject([{ name: 'My Server!', state: 'connected', tools: ['echo'] }])
    const [t] = h.tools()
    expect(t!.function.name).toBe('My_Server___echo')
    expect(h.describe('My_Server___echo')).toEqual({ server: 'My Server!', tool: 'echo' })
    expect(await h.call('My_Server___echo', { text: 'hi' })).toEqual({ text: 'ECHO:hi', isError: false })
    expect((await h.call('nope', {})).isError).toBe(true)
    await h.shutdown()
  }, 20000)

  it('reports a server that cannot start, and skips disabled ones', async () => {
    const h = new McpHost()
    await h.sync([cfg({ id: 'bad', name: 'bad', command: '/no/such/binary' }), cfg({ id: 'off', name: 'off', enabled: false })])
    const st = Object.fromEntries(h.status().map((s) => [s.name, s]))
    expect(st.bad!.state).toBe('error')
    expect(st.bad!.error).toBeTruthy()
    expect(st.off!.state).toBe('disabled')
    expect(h.tools()).toEqual([])
    await h.shutdown()
  }, 20000)

  it('restarts a server when its config changes and drops removed ones', async () => {
    const h = new McpHost()
    await h.sync([cfg()])
    await h.sync([cfg({ name: 'renamed' })])
    expect(h.tools()[0]!.function.name).toBe('renamed__echo')
    await h.sync([])
    expect(h.status()).toEqual([])
    await h.shutdown()
  }, 20000)
})

describe('toAcpServers', () => {
  it('keeps only enabled servers and converts env', () => {
    expect(toAcpServers([cfg({ env: { A: '1' } }), cfg({ id: 'b', enabled: false })])).toEqual([{ name: 'My Server!', command: process.execPath, args: [resolve('tests/fixtures/mini-mcp.mjs')], env: [{ name: 'A', value: '1' }] }])
  })
})
