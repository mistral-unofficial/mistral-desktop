import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

/** A right-click menu at a screen position. Closes on a click elsewhere, Esc, scrolling, resizing or choosing an item. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [x, y])
  useEffect(() => {
    const close = (): void => onClose()
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const i = btns.indexOf(document.activeElement as HTMLButtonElement)
        btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus()
        e.preventDefault()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true, capture: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close, true)
    }
  }, [onClose])

  return (
    <ul className="ctxmenu" role="menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it) => (
        <li key={it.label} role="none">
          <button role="menuitem" className={it.danger ? 'danger-item' : ''} onClick={() => { onClose(); it.onSelect() }}>{it.label}</button>
        </li>
      ))}
    </ul>
  )
}
