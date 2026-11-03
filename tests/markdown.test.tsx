import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/src/components'

const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown', () => {
  it('renders common formatting', () => {
    const out = html('# Title\n\n**bold** and *em* and `code`\n\n- a\n- b\n\n1. one\n\n> quote\n\n~~gone~~')
    expect(out).toContain('<h1>Title</h1>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>em</em>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<ol>')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('<del>gone</del>')
  })
  it('renders GFM tables inside a scroll wrapper', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out).toContain('class="md-table"')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<td>2</td>')
  })
  it('renders code blocks with a language label and copy button', () => {
    const out = html('```ts\nconst x = 1\n```')
    expect(out).toContain('codeblock-wrap')
    expect(out).toContain('<span>ts</span>')
    expect(out).toContain('aria-label="Copy code"')
    expect(out).toContain('const x = 1')
  })
  it('tolerates an unterminated code fence while streaming', () => {
    expect(html('Here:\n```py\nprint(1)')).toContain('print(1)')
  })
  it('never injects raw HTML', () => {
    const out = html('<script>alert(1)</script><img src=x onerror=alert(1)><b>x</b>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;script&gt;')
  })
  it('only links http, https and mailto; opens them safely', () => {
    expect(html('[ok](https://example.com)')).toContain('href="https://example.com"')
    expect(html('[ok](https://example.com)')).toContain('rel="noopener noreferrer"')
    expect(html('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"')
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'vbscript:x']) {
      expect(html(`[bad](${bad})`)).not.toContain('href=')
    }
  })
  it('does not load images', () => {
    const out = html('![cat](https://tracker.example/p.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('[image: cat]')
  })
})
