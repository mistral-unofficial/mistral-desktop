import { describe, expect, it } from 'vitest'
import { describeCommand, initialFormValues, placeholderFor } from '../src/renderer/src/configForm'

describe('configForm', () => {
  const fields = {
    n: { type: 'number' as const, title: 'n', description: '' },
    b: { type: 'boolean' as const, title: 'b', description: '' },
    l: { type: 'string' as const, title: 'l', description: '', multiple: true },
    s: { type: 'string' as const, title: 's', description: '', sensitive: true }
  }
  it('maps stored values to form values', () => {
    expect(initialFormValues(fields, { n: 3, b: true, l: ['a', 'b'] })).toEqual({ n: '3', b: true, l: 'a\nb', s: '' })
    expect(initialFormValues(fields, {})).toEqual({ n: '', b: false, l: '', s: '' })
  })
  it('placeholders', () => {
    expect(placeholderFor(fields.s, true)).toContain('unchanged')
    expect(placeholderFor(fields.s, false)).toBeUndefined()
    expect(placeholderFor(fields.l, false)).toBe('One per line')
  })
  it('quotes arguments with spaces in the command preview', () => {
    expect(describeCommand('node', ['a b.js', '--x'])).toBe('node "a b.js" --x')
    expect(describeCommand('node', ['${__dirname}/server/index.js'])).toBe('node <extension>/server/index.js')
  })
})
