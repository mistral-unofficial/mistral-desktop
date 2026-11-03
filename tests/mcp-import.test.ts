import { describe, expect, it } from 'vitest'
import { envToText, parseMcpJson, textToArgs, textToEnv } from '../src/renderer/src/mcpImport'

describe('parseMcpJson', () => {
  it('reads the Claude Desktop format and stringifies env values', () => {
    const { servers, skipped } = parseMcpJson(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x', 1], env: { A: 2 } }, off: { command: 'c', disabled: true } } }))
    expect(skipped).toEqual([])
    expect(servers).toMatchObject([{ name: 'fs', command: 'npx', args: ['-y', 'x', '1'], env: { A: '2' }, enabled: true }, { name: 'off', enabled: false }])
    expect(new Set(servers.map((s) => s.id)).size).toBe(2)
  })
  it('accepts a bare map and reports remote servers as skipped', () => {
    const { servers, skipped } = parseMcpJson(JSON.stringify({ a: { command: 'x' }, remote: { url: 'https://h/mcp' } }))
    expect(servers.map((s) => s.name)).toEqual(['a'])
    expect(skipped).toEqual(['remote'])
  })
  it('throws on invalid JSON and non-objects', () => {
    expect(() => parseMcpJson('{nope')).toThrow()
    expect(() => parseMcpJson('[]')).toThrow(/object/)
  })
})

describe('text helpers', () => {
  it('round-trips env and trims args', () => {
    expect(textToEnv('A=1\nB=x=y\nbad\n=z')).toEqual({ A: '1', B: 'x=y' })
    expect(textToEnv(envToText({ K: 'v=1' }))).toEqual({ K: 'v=1' })
    expect(textToArgs(' a \n\n b')).toEqual(['a', 'b'])
  })
})
