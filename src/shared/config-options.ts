import type { CodeConfigOption } from './types'

/**
 * Turns the ACP `configOptions` list (select options such as model and thinking level) into a flat shape for the UI.
 * Grouped choices are flattened; options that are not selects (toggles) and malformed entries are dropped.
 */
export function normalizeConfigOptions(raw: unknown): CodeConfigOption[] {
  if (!Array.isArray(raw)) return []
  const out: CodeConfigOption[] = []
  for (const o of raw as Record<string, unknown>[]) {
    if (!o || o.type !== 'select' || typeof o.id !== 'string') continue
    const choices = (Array.isArray(o.options) ? (o.options as Record<string, unknown>[]) : [])
      .flatMap((x) => (Array.isArray(x?.options) ? (x.options as Record<string, unknown>[]) : [x]))
      .filter((x): x is Record<string, unknown> & { value: string } => typeof x?.value === 'string')
      .map((x) => ({ value: x.value, name: typeof x.name === 'string' && x.name ? x.name : x.value, description: typeof x.description === 'string' ? x.description : undefined }))
    out.push({ id: o.id, name: typeof o.name === 'string' ? o.name : o.id, category: typeof o.category === 'string' ? o.category : undefined, value: String(o.currentValue ?? ''), choices })
  }
  return out
}
