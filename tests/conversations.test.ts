import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/types'
import { ConversationStore } from '../src/main/conversations'

const conv = (id: string, title: string, updatedAt: number, text: string): Conversation => ({ id, title, updatedAt, model: 'm', wire: [], items: [{ kind: 'user', text }, { kind: 'assistant', text: 'ok' }] })

describe('ConversationStore.search', () => {
  it('matches titles and message text, newest first, with a snippet for text matches', () => {
    const s = new ConversationStore(mkdtempSync(join(tmpdir(), 'md-conv-')))
    s.save(conv('a', 'Pasta recipe', 1, 'how long to boil'))
    s.save(conv('b', 'Taxes', 2, 'what is the deadline for PASTA tax?'))
    s.save(conv('c', 'Other', 3, 'nothing'))
    expect(s.search('').map((h) => h.id)).toEqual(['c', 'b', 'a'])
    const hits = s.search('pasta')
    expect(hits.map((h) => h.id)).toEqual(['b', 'a'])
    expect(hits[0]!.snippet).toContain('PASTA')
    expect(hits[1]!.snippet).toBeUndefined()
    expect(s.search('zzz')).toEqual([])
  })
})
