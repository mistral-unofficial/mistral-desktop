import { type ReactNode, useState } from 'react'
import { lineDiff, type DiffContent } from './codeState'

/** Minimal rendering: fenced code blocks and plain text. Deliberately no HTML injection. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return (
    <div className="rich">
      {parts.map((p, i) => {
        if (p.startsWith('```')) {
          const body = p.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
          return <pre key={i} className="codeblock"><code>{body}</code></pre>
        }
        return p ? <p key={i}>{p}</p> : null
      })}
    </div>
  )
}

export function Collapsible({ summary, children, open = false }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  const [o, setO] = useState(open)
  return (
    <div className="collapsible">
      <button className="linklike" onClick={() => setO(!o)} aria-expanded={o}>{o ? '▾' : '▸'} {summary}</button>
      {o && <div className="collapsible-body">{children}</div>}
    </div>
  )
}

export function Diff({ d }: { d: DiffContent }) {
  const lines = lineDiff(d.oldText, d.newText)
  return (
    <div className="diff">
      <div className="diff-path">{d.path}</div>
      <pre>{lines.map((l, i) => <div key={i} className={`dl ${l.type}`}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</div>)}</pre>
    </div>
  )
}
