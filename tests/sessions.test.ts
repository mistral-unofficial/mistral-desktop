import { describe, expect, it } from 'vitest'
import { mergePending } from '../src/renderer/src/sessions'

const s = (sessionId: string, title = sessionId) => ({ sessionId, title, updatedAt: null })

describe('mergePending', () => {
  it('puts a just-started session first in its folder', () => {
    const out = mergePending([{ path: '/a', sessions: [s('old')] }, { path: '/b', sessions: [] }], [{ path: '/a', session: s('new', 'Fix the parser') }])
    expect(out[0]!.sessions.map((x) => x.sessionId)).toEqual(['new', 'old'])
    expect(out[1]!.sessions).toEqual([])
  })
  it('drops the stand-in once Vibe lists that session, keeping Vibe\'s title', () => {
    const out = mergePending([{ path: '/a', sessions: [s('new', 'Vibe title')] }], [{ path: '/a', session: s('new', 'my first message') }])
    expect(out[0]!.sessions).toEqual([s('new', 'Vibe title')])
  })
  it('adds a folder that is not listed yet, and changes nothing without pending sessions', () => {
    expect(mergePending([{ path: '/a', sessions: [] }], [{ path: '/z', session: s('n') }]).map((w) => w.path)).toEqual(['/z', '/a'])
    const ws = [{ path: '/a', sessions: [s('x')] }]
    expect(mergePending(ws, [])).toEqual(ws)
  })
})
