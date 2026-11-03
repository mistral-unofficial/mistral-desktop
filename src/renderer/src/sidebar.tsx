import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type SidebarTab = 'chat' | 'code'

/** The app sidebar owns one slot element per tab; views render their sidebar content into theirs. */
export const SidebarSlots = createContext<Partial<Record<SidebarTab, HTMLElement | null>>>({})

export function SidebarPortal({ tab, children }: { tab: SidebarTab; children: ReactNode }) {
  const el = useContext(SidebarSlots)[tab]
  return el ? createPortal(children, el) : null
}
