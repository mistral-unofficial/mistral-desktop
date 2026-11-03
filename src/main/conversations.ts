import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, ConversationHit } from '../shared/types'

const ID = /^[A-Za-z0-9-]{1,64}$/

export class ConversationStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  private path(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid conversation id')
    return join(this.dir, `${id}.json`)
  }
  list(): Pick<Conversation, 'id' | 'title' | 'updatedAt'>[] {
    const out: Pick<Conversation, 'id' | 'title' | 'updatedAt'>[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Conversation
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt })
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  /** Title or message-text match (case-insensitive); an empty query lists everything. */
  search(query: string): ConversationHit[] {
    const q = query.trim().toLowerCase()
    const out: ConversationHit[] = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Conversation
        const hit: ConversationHit = { id: c.id, title: c.title, updatedAt: c.updatedAt }
        if (q && !c.title.toLowerCase().includes(q)) {
          const text = c.items.flatMap((i) => (i.kind === 'user' || i.kind === 'assistant' ? [i.text] : [])).find((t) => t.toLowerCase().includes(q))
          if (!text) continue
          const at = Math.max(0, text.toLowerCase().indexOf(q) - 30)
          hit.snippet = (at > 0 ? '…' : '') + text.slice(at, at + 100).replace(/\s+/g, ' ')
        }
        out.push(hit)
      } catch {
        /* skip corrupt file */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  get(id: string): Conversation | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id), 'utf8')) as Conversation
    } catch {
      return undefined
    }
  }
  save(c: Conversation): void {
    const p = this.path(c.id)
    writeFileSync(`${p}.tmp`, JSON.stringify(c))
    renameSync(`${p}.tmp`, p)
  }
  remove(id: string): void {
    try {
      unlinkSync(this.path(id))
    } catch {
      /* already gone */
    }
  }
}
