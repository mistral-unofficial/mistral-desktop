import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { findActiveMention, formatMention } from '@shared/mentions'
import { type FileEntry, highlightIndices, matchEntries, sortEntries } from './fileMatch'

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder?: string
  /** Changes whenever the project changes, so the file list is fetched again. */
  sessionKey: string
  loadFiles: () => Promise<{ entries: FileEntry[]; truncated: boolean }>
}

const RELOAD_AFTER_MS = 8000

/** A textarea that completes `@path` mentions of the project's files (fuzzy, like the Vibe CLI). */
export function MentionTextarea({ value, onChange, onSubmit, disabled, placeholder, sessionKey, loadFiles }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [files, setFiles] = useState<{ entries: FileEntry[]; truncated: boolean } | null>(null)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const loadedAt = useRef(0)
  const pendingCaret = useRef<number | null>(null)
  const listId = 'mention-list'

  const mention = useMemo(() => (disabled ? null : findActiveMention(value, caret)), [value, caret, disabled])
  const open = mention !== null && dismissed !== mention.start

  useEffect(() => {
    setFiles(null)
    loadedAt.current = 0
  }, [sessionKey])

  // Fetch (or refresh) the file list when a mention starts.
  useEffect(() => {
    if (!open || (files && Date.now() - loadedAt.current < RELOAD_AFTER_MS)) return
    loadedAt.current = Date.now()
    let stale = false
    loadFiles().then(
      (r) => !stale && setFiles({ entries: sortEntries(r.entries), truncated: r.truncated }),
      () => !stale && setFiles({ entries: [], truncated: false })
    )
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mention?.start, sessionKey])

  const results = useMemo(() => (open && files && mention ? matchEntries(files.entries, mention.query, 8).filter((e) => formatMention(e.path, e.kind) !== undefined) : []), [open, files, mention])
  useEffect(() => setActive(0), [mention?.query, mention?.start])
  useEffect(() => {
    if (mention === null) setDismissed(null)
  }, [mention])
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  })

  const accept = (entry: FileEntry): void => {
    if (!mention) return
    const text = formatMention(entry.path, entry.kind)
    if (text === undefined) return
    const next = value.slice(0, mention.start) + text + value.slice(mention.end)
    pendingCaret.current = mention.start + text.length
    setCaret(mention.start + text.length)
    onChange(next)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (open && results.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        accept(results[Math.min(active, results.length - 1)]!)
        return
      }
    }
    if (open && e.key === 'Escape' && mention) {
      e.preventDefault()
      setDismissed(mention.start)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  const showList = open && (results.length > 0 || files === null || (mention!.query !== '' && files !== null))
  return (
    <div className="mention-wrap">
      {showList && (
        <ul id={listId} className="mention-list" role="listbox" aria-label="Files">
          {files === null && <li className="mention-note">Loading files…</li>}
          {files !== null && results.length === 0 && <li className="mention-note">No matching files</li>}
          {results.map((r, i) => {
            const hl = highlightIndices(mention!.query, r.path)
            const name = r.path.slice(r.path.lastIndexOf('/') + 1)
            const dir = r.path.slice(0, r.path.length - name.length)
            const base = r.path.length - name.length
            return (
              <li key={r.path + r.kind} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'mention-item active' : 'mention-item'} onMouseDown={(e) => (e.preventDefault(), accept(r))} onMouseMove={() => setActive(i)}>
                <span className="mention-icon" aria-hidden="true">{r.kind === 'folder' ? '📁' : '📄'}</span>
                <span className="mention-name">{[...name].map((c, k) => (hl.has(base + k) ? <b key={k}>{c}</b> : c))}{r.kind === 'folder' ? '/' : ''}</span>
                {dir && <span className="mention-dir">{[...dir].map((c, k) => (hl.has(k) ? <b key={k}>{c}</b> : c))}</span>}
              </li>
            )
          })}
          {files?.truncated && results.length > 0 && <li className="mention-note">Very large project: not every file is listed</li>}
        </ul>
      )}
      <textarea
        ref={ref}
        value={value}
        disabled={disabled}
        rows={2}
        placeholder={placeholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={showList && results.length ? `${listId}-${active}` : undefined}
        onChange={(e) => (setCaret(e.target.selectionStart), onChange(e.target.value))}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => setDismissed(null)}
        onBlur={() => setDismissed(mention ? mention.start : null)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
