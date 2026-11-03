import type { UserConfigField, UserConfigValue } from '@shared/types'

export type FormValues = Record<string, string | boolean>

/** Turn stored/default values into what the form inputs hold (everything is a string, except booleans). */
export function initialFormValues(fields: Record<string, UserConfigField>, base: Record<string, UserConfigValue>): FormValues {
  const out: FormValues = {}
  for (const [k, f] of Object.entries(fields)) {
    const v = base[k]
    if (f.type === 'boolean') out[k] = v === true || v === 'true'
    else if (Array.isArray(v)) out[k] = v.join('\n')
    else out[k] = v === undefined ? '' : String(v)
  }
  return out
}

/** Sensitive fields that already have a stored secret start empty and mean "unchanged" when left empty. */
export function placeholderFor(f: UserConfigField, hasSecret: boolean): string | undefined {
  if (f.sensitive && hasSecret) return '•••••••• (unchanged)'
  if (f.multiple) return 'One per line'
  return undefined
}

/** Command line shown before install. `${__dirname}` is the folder the extension is unpacked into. */
export function describeCommand(command: string, args: string[]): string {
  return [command, ...args].map((p) => p.split('${__dirname}').join('<extension>')).map((p) => (/\s/.test(p) ? JSON.stringify(p) : p)).join(' ')
}
