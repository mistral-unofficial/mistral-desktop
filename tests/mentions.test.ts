import { describe, expect, it } from 'vitest'
import { findActiveMention, formatMention } from '../src/shared/mentions'

const at = (text: string, caret = text.length) => findActiveMention(text, caret)

describe('findActiveMention', () => {
  it('finds a mention at the start, after a space and after a newline', () => {
    expect(at('@src')).toMatchObject({ start: 0, query: 'src', quoted: false })
    expect(at('read @src/ap')).toMatchObject({ start: 5, query: 'src/ap' })
    expect(at('line one\n@x')).toMatchObject({ start: 9, query: 'x' })
    expect(at('@')).toMatchObject({ start: 0, query: '' })
  })
  it('anchors after anything but a letter, digit or underscore (as Vibe does)', () => {
    expect(at('see (@a')).toMatchObject({ start: 5, query: 'a' })
    expect(at('x-@a')).toMatchObject({ start: 2 })
    expect(at('"@a')).toMatchObject({ start: 1 })
  })
  it('does not treat an @ inside a word (email, handle) as a mention', () => {
    expect(at('mail me@example.com')).toBeNull()
    expect(at('a@b')).toBeNull()
    expect(at('snake_case@b')).toBeNull()
    expect(at('é@b')).toBeNull() // non-ASCII letters count as word characters too
  })
  it('ends at characters Vibe would not read as part of a path', () => {
    expect(at('@src/app.ts then')).toBeNull() // space
    expect(at('@a+b')).toBeNull() // '+' is not a path character: Vibe reads the mention as "a"
    expect(at('@src,')).toBeNull()
    expect(at('plain text')).toBeNull()
  })
  it('accepts every character Vibe allows in an unquoted path', () => {
    expect(at('@a_b-c.d/e\\f(g)[h]{i}~j')).toMatchObject({ query: 'a_b-c.d/e\\f(g)[h]{i}~j' })
    expect(at('@über/größe')).toMatchObject({ query: 'über/größe' })
  })
  it('uses the caret; an unquoted token extends over the rest of its path characters', () => {
    const t = 'open @src/app.tsx now'
    expect(at(t, 9)).toMatchObject({ start: 5, query: 'src', end: 17 })
    expect(t.slice(5, 17)).toBe('@src/app.tsx')
  })
  it('supports quoted paths (double or single quotes) with spaces and punctuation', () => {
    expect(at('@"my fo')).toMatchObject({ start: 0, query: 'my fo', quoted: true })
    expect(at("x @'a+b c")).toMatchObject({ start: 2, query: 'a+b c', quoted: true })
    expect(at('@"a\\"b')).toMatchObject({ query: 'a"b', quoted: true }) // \" is an escaped quote
  })
  it('a quoted mention closed before the caret is finished; text after it is not a mention', () => {
    expect(at('@"closed one" more')).toBeNull()
    expect(at('@"closed"x')).toBeNull()
  })
  it('a quoted mention ends at its closing quote, or the end of the line when unclosed', () => {
    const t = '@"my folder/x" tail'
    expect(at(t, 5)).toMatchObject({ end: 14 })
    expect(at('@"open\nnext line', 4)).toMatchObject({ end: 6 })
  })
  it('a quote on an earlier line does not leak into the next one', () => {
    expect(at('@"a\nplain')).toBeNull()
  })
  it('picks the nearest @ that is a valid mention', () => {
    expect(at('@a @b')).toMatchObject({ start: 3, query: 'b' })
    expect(at('@a@b')).toBeNull()
  })
})

describe('formatMention', () => {
  it('adds a trailing space for files and keeps folders open', () => {
    expect(formatMention('src/app.ts', 'file')).toBe('@src/app.ts ')
    expect(formatMention('src', 'folder')).toBe('@src/')
    expect(formatMention('weird_name-1.(a)[b]{c}.ts', 'file')).toBe('@weird_name-1.(a)[b]{c}.ts ')
  })
  it('quotes names with spaces or characters Vibe would not read as part of a path', () => {
    expect(formatMention('my dir/a b.txt', 'file')).toBe('@"my dir/a b.txt" ')
    expect(formatMention('my dir', 'folder')).toBe('@"my dir/')
    expect(formatMention('a+b.txt', 'file')).toBe('@"a+b.txt" ')
    expect(formatMention('c#/x.cs', 'file')).toBe('@"c#/x.cs" ')
    expect(formatMention('a,b.txt', 'file')).toBe('@"a,b.txt" ')
    expect(formatMention('it@home.txt', 'file')).toBe('@"it@home.txt" ')
  })
  it('switches quote style when the name contains a quote, and refuses when both occur', () => {
    expect(formatMention('say "hi".txt', 'file')).toBe(`@'say "hi".txt' `)
    expect(formatMention("it's.txt", 'file')).toBe('@"it\'s.txt" ')
    expect(formatMention(`a "b" 'c'.txt`, 'file')).toBeUndefined()
  })
  it('protects names starting with ~ from home-directory expansion', () => {
    expect(formatMention('~backup.txt', 'file')).toBe('@./~backup.txt ')
  })
  it('a completed quoted folder continues as an active mention; a completed file does not', () => {
    expect(at(formatMention('my dir', 'folder')!)).toMatchObject({ query: 'my dir/', quoted: true })
    expect(at(formatMention('my dir/f.txt', 'file')!)).toBeNull()
    expect(at(formatMention('src', 'folder')!)).toMatchObject({ query: 'src/' })
  })
})
