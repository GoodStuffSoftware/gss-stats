import { describe, expect, it } from 'vitest'
import { parseNoteInline, parseNoteMarkdown, safeNoteHref } from './noteMarkdown'

const text = (s: string) => parseNoteInline(s).map((t) => t.value).join('')

describe('old one-line notes', () => {
  const corpus = ['*', '#1', '# not a heading', '5 * 3', '2*3*4', 'a_b_c', '<b>x</b>', '[x]', '- x', '1. x', '**', '_', 'snake_case_name here', '2**3**4', '2**3**4 and 4**5', 'a**b**c']
  for (const note of corpus) {
    it(`stays literal: ${note}`, () => {
      expect(parseNoteMarkdown(note)).toEqual([{ type: 'p', lines: [[{ type: 'text', value: note }]] }])
    })
  }
  it('a bare address becomes a link with the same text', () => {
    expect(parseNoteInline('https://example.com')).toEqual([{ type: 'link', value: 'https://example.com', href: 'https://example.com' }])
  })
  it('trailing sentence punctuation stays outside the link', () => {
    expect(parseNoteInline('see https://example.com/a.')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com/a', href: 'https://example.com/a' },
      { type: 'text', value: '.' },
    ])
  })
})

describe('unsafe links stay inert', () => {
  const bad = ['javascript:alert(1)', 'data:text/html,<script>1</script>', '//evil.com', '/relative', 'ftp://x.com', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'https:evil.com', 'mailto:a@b.com']
  for (const href of bad) {
    it(`label only: ${JSON.stringify(href)}`, () => {
      expect(parseNoteInline(`[click](${href})`)).toEqual([{ type: 'text', value: 'click' }])
    })
  }
  it('control characters inside an http href are stripped from the result', () => {
    expect(safeNoteHref('ht\ttps://exa\nmple.com')).toBe('https://example.com')
  })
  it('<script> and html are plain text', () => {
    expect(parseNoteInline('<script>alert(1)</script>')).toEqual([{ type: 'text', value: '<script>alert(1)</script>' }])
    expect(text('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>')
  })
  it('a bare javascript: address is not linked', () => {
    expect(parseNoteInline('javascript:alert(1)').every((t) => t.type === 'text')).toBe(true)
  })
})

describe('markup', () => {
  it('bold, italic, code and links', () => {
    expect(parseNoteInline('a **b** *c* _d_ `e` [f](https://x.com)')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'bold', value: 'b' },
      { type: 'text', value: ' ' },
      { type: 'italic', value: 'c' },
      { type: 'text', value: ' ' },
      { type: 'italic', value: 'd' },
      { type: 'text', value: ' ' },
      { type: 'code', value: 'e' },
      { type: 'text', value: ' ' },
      { type: 'link', value: 'f', href: 'https://x.com' },
    ])
  })
  it('code protects markup inside it', () => {
    expect(parseNoteInline('`**x**`')).toEqual([{ type: 'code', value: '**x**' }])
  })
  it('lists need two or more lines', () => {
    expect(parseNoteMarkdown('intro\n- a\n- b\n\n1. one\n2) two')).toEqual([
      { type: 'p', lines: [[{ type: 'text', value: 'intro' }]] },
      { type: 'ul', items: [[{ type: 'text', value: 'a' }], [{ type: 'text', value: 'b' }]] },
      { type: 'ol', items: [[{ type: 'text', value: 'one' }], [{ type: 'text', value: 'two' }]] },
    ])
  })
  it('paragraphs and line breaks', () => {
    const b = parseNoteMarkdown('one\ntwo\n\nthree')
    expect(b).toHaveLength(2)
    expect(b[0]).toMatchObject({ type: 'p', lines: [[{ value: 'one' }], [{ value: 'two' }]] })
  })
  it('empty note has no blocks', () => {
    expect(parseNoteMarkdown('  \n ')).toEqual([])
  })
})
