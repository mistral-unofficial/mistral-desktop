import { describe, expect, it } from 'vitest'
import { envToText, headersToText, parseMcpJson, textToArgs, textToEnv, textToHeaders } from '../src/renderer/src/mcpImport'

describe('parseMcpJson', () => {
  it('reads the Claude Desktop format and stringifies env values', () => {
    const { servers, skipped } = parseMcpJson(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'x', 1], env: { A: 2 } }, off: { command: 'c', disabled: true } } }))
    expect(skipped).toEqual([])
    expect(servers).toMatchObject([{ name: 'fs', command: 'npx', args: ['-y', 'x', '1'], env: { A: '2' }, enabled: true }, { name: 'off', enabled: false }])
    expect(new Set(servers.map((s) => s.id)).size).toBe(2)
  })
  it('accepts a bare map, imports remote (url) servers and reports unusable entries', () => {
    const { servers, skipped } = parseMcpJson(JSON.stringify({ a: { command: 'x' }, remote: { url: 'https://h/mcp' }, withKey: { url: 'https://k/mcp', headers: { authorization: 'Bearer t' } }, junk: { foo: 1 } }))
    expect(servers.map((s) => s.name)).toEqual(['a', 'remote', 'withKey'])
    expect(servers[1]).toMatchObject({ transport: 'http', url: 'https://h/mcp', oauth: true, enabled: true })
    expect(servers[2]).toMatchObject({ oauth: false, headers: { authorization: 'Bearer t' } })
    expect(skipped).toEqual(['junk'])
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
    expect(textToHeaders('Authorization: Bearer a:b\nX-A:1\nbad')).toEqual({ Authorization: 'Bearer a:b', 'X-A': '1' })
    expect(textToHeaders(headersToText({ K: 'v: w' }))).toEqual({ K: 'v: w' })
  })
})
