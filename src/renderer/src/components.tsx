import { Children, isValidElement, memo, type ReactElement, type ReactNode, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { lineDiff, type DiffContent } from './codeState'

/** Plain text with preserved line breaks (used for what the user typed). */
export function PlainText({ text }: { text: string }) {
  return <div className="plain">{text}</div>
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="codeblock-wrap">
      <div className="codeblock-head">
        <span>{lang ?? 'text'}</span>
        <button className="linklike" onClick={copy} aria-label="Copy code">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="codeblock"><code>{code}</code></pre>
    </div>
  )
}

/**
 * Markdown is rendered with react-markdown: raw HTML in the text is shown as text, never injected.
 * Links open in the system browser (http/https/mailto only); images are not loaded.
 */
const components: Components = {
  pre({ children }) {
    const child = Children.toArray(children)[0]
    if (isValidElement(child)) {
      const el = child as ReactElement<{ className?: string; children?: ReactNode }>
      const lang = /language-([\w+-]+)/.exec(el.props.className ?? '')?.[1]
      const code = Children.toArray(el.props.children).join('').replace(/\n$/, '')
      return <CodeBlock lang={lang} code={code} />
    }
    return <pre className="codeblock">{children}</pre>
  },
  a({ href, children }) {
    if (!href || !SAFE_LINK.test(href)) return <span className="md-deadlink">{children}</span>
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  img({ alt, src }) {
    return <span className="md-img" title={src}>[image{alt ? `: ${alt}` : ''}]</span>
  },
  table({ children }) {
    return <div className="md-table"><table>{children}</table></div>
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  )
})

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

export interface QuestionSpec {
  question: string
  header?: string
  options: string[]
  /** Several options may be chosen. */
  multi?: boolean
}

/**
 * An agent's question(s), one block per question. Options are suggestions: free text is always accepted. With a
 * single single-choice question, picking an option answers at once. Answers are lists of labels per question.
 */
export function QuestionCard({ questions, footer, onSubmit, onDismiss }: { questions: QuestionSpec[]; footer?: string; onSubmit: (answers: string[][]) => void; onDismiss?: () => void }) {
  const [sel, setSel] = useState<string[][]>(() => questions.map(() => []))
  const [free, setFree] = useState<string[]>(() => questions.map(() => ''))
  const instant = questions.length === 1 && !questions[0]!.multi
  const answerOf = (i: number): string[] => {
    const f = free[i]?.trim()
    return questions[i]!.multi ? [...(sel[i] ?? []), ...(f ? [f] : [])] : f ? [f] : (sel[i] ?? [])
  }
  const all = (): string[][] => questions.map((_, i) => answerOf(i))
  const ready = questions.every((_, i) => answerOf(i).length > 0)
  const pick = (i: number, o: string): void => {
    if (instant) return onSubmit([[o]])
    setSel((a) => a.map((x, j) => (j !== i ? x : questions[i]!.multi ? (x.includes(o) ? x.filter((y) => y !== o) : [...x, o]) : [o])))
    if (!questions[i]!.multi) setFree((a) => a.map((x, j) => (j === i ? '' : x)))
  }
  return (
    <div className="workq" role="group" aria-label="The agent has a question">
      {questions.map((q, i) => (
        <div key={i} className="workq-item">
          {q.header && <div className="muted workq-head">{q.header}</div>}
          <div className="workq-text">{q.question}</div>
          <div className="workq-options">
            {q.options.map((o, n) => {
              const on = (sel[i] ?? []).includes(o) && !(!q.multi && free[i]?.trim())
              return (
                <button key={o} type="button" aria-pressed={on} className={on ? 'workq-opt selected' : 'workq-opt'} onClick={() => pick(i, o)}>
                  <span className="workq-n">{q.multi ? (on ? '✓' : '') : n + 1}</span>{o}
                </button>
              )
            })}
            <input
              className="workq-free"
              value={free[i] ?? ''}
              placeholder={q.multi ? 'Add your own…' : 'Or type your own answer…'}
              onChange={(e) => setFree((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && ready) { e.preventDefault(); onSubmit(all()) } }}
            />
          </div>
        </div>
      ))}
      {footer && <div className="muted workq-note">{footer}</div>}
      <div className="workq-foot">
        {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
        <button type="button" className="primary" disabled={!ready} onClick={() => onSubmit(all())}>{questions.length === 1 ? 'Answer' : 'Submit answers'}</button>
      </div>
    </div>
  )
}
