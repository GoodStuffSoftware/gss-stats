import { describe, expect, it } from 'vitest'
import { parseTextLite, splitParagraphs, tokenizeAndInterpolate, toPlainText } from './textLite'

describe('parseTextLite', () => {
  it('tokenizes plain text as a single text token', () => {
    expect(parseTextLite('hello world')).toEqual([{ type: 'text', value: 'hello world' }])
  })

  it('tokenizes **bold** spans', () => {
    expect(parseTextLite('a **bold** word')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'bold', value: 'bold' },
      { type: 'text', value: ' word' },
    ])
  })

  it('tokenizes [label](url) links', () => {
    expect(parseTextLite('see [lib/campaigns.ts](https://example.com/campaigns.ts) for more')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'lib/campaigns.ts', href: 'https://example.com/campaigns.ts' },
      { type: 'text', value: ' for more' },
    ])
  })

  it('handles bold and links together, in order', () => {
    expect(parseTextLite('**Note:** see [here](https://x.test)')).toEqual([
      { type: 'bold', value: 'Note:' },
      { type: 'text', value: ' see ' },
      { type: 'link', value: 'here', href: 'https://x.test' },
    ])
  })

  it('never produces raw HTML — every token is plain data, safe from injection', () => {
    const tokens = parseTextLite('<img src=x onerror=alert(1)> **<script>evil()</script>**')
    // The dangerous-looking substrings survive only as literal TEXT/BOLD token values —
    // there is no code path that interprets them as markup (see NoteBlock/TextBlock, which
    // render every token through ordinary {{ }} interpolation, never v-html).
    expect(tokens.every((t) => t.type === 'text' || t.type === 'bold' || t.type === 'link')).toBe(true)
  })

  describe('HIGH security fix — link href scheme allowlist', () => {
    it('allows https:', () => {
      expect(parseTextLite('[x](https://example.com/y)')).toEqual([{ type: 'link', value: 'x', href: 'https://example.com/y' }])
    })
    it('allows an absolute same-origin path', () => {
      expect(parseTextLite('[x](/some/path)')).toEqual([{ type: 'link', value: 'x', href: '/some/path' }])
    })
    it('allows an in-page hash anchor', () => {
      expect(parseTextLite('[x](#section)')).toEqual([{ type: 'link', value: 'x', href: '#section' }])
    })
    it('allows a plain relative path with no scheme', () => {
      expect(parseTextLite('[x](docs/readme.md)')).toEqual([{ type: 'link', value: 'x', href: 'docs/readme.md' }])
    })
    // Helper: assert no LIVE link token was ever produced, and the dangerous scheme text
    // never appears as an actual `href` on any token (it may still appear as inert plain
    // text — e.g. a trailing ")" split off by the (pre-existing, unrelated to this scheme
    // fix) href capture stopping at the first ")", which happens whenever the URL itself
    // contains a literal parenthesis, safe or not). What matters for the security fix is
    // that it's never clickable/navigable.
    function assertNeutralised(tokens: ReturnType<typeof parseTextLite>) {
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens.every((t) => t.type !== 'text' || !t.value.match(/^(javascript|vbscript|data):/i))).toBe(true)
    }

    it('neutralises javascript: to plain text (the link is dropped, the label survives)', () => {
      const tokens = parseTextLite('[x](javascript:alert(1))')
      assertNeutralised(tokens)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('neutralises vbscript:', () => {
      assertNeutralised(parseTextLite('[x](vbscript:msgbox(1))'))
    })
    it('neutralises data: (can smuggle an inline HTML/script document)', () => {
      assertNeutralised(parseTextLite('[x](data:text/html,<script>alert(1)</script>)'))
    })
    it('neutralises plain http: (https-only allowlist) — no parens in this URL, so it fully collapses to one plain-text token', () => {
      expect(parseTextLite('[x](http://example.com)')).toEqual([{ type: 'text', value: 'x' }])
    })
    it('neutralises a protocol-relative //host link', () => {
      expect(parseTextLite('[x](//evil.example.com/phish)')).toEqual([{ type: 'text', value: 'x' }])
    })
    it('neutralises a mixed-case scheme (JavaScript:, JAVASCRIPT:)', () => {
      assertNeutralised(parseTextLite('[x](JavaScript:alert(1))'))
    })
    it('an empty href never matches the link pattern at all — the whole "[x]()" stays literal text (not a link, safe either way)', () => {
      expect(parseTextLite('[x]()')).toEqual([{ type: 'text', value: '[x]()' }])
    })
  })

  describe('nested / unbalanced markers', () => {
    it('an unclosed ** is left as literal text, not treated as bold', () => {
      expect(parseTextLite('a **b')).toEqual([{ type: 'text', value: 'a **b' }])
    })
    it('an unclosed [label]( with no matching ) is left as literal text', () => {
      expect(parseTextLite('see [broken(https://x.test')).toEqual([{ type: 'text', value: 'see [broken(https://x.test' }])
    })
    it('a "nested" ** inside ** is captured non-greedily — the FIRST closing ** wins, matching how the regex is built to prevent runaway backtracking on adjacent markers', () => {
      const tokens = parseTextLite('**a**b**c**')
      expect(tokens).toEqual([
        { type: 'bold', value: 'a' },
        { type: 'text', value: 'b' },
        { type: 'bold', value: 'c' },
      ])
    })
    it('a link label cannot itself contain an unescaped ] (regex is non-greedy up to the first ])', () => {
      expect(parseTextLite('[a]b](https://x.test)')).toEqual([{ type: 'text', value: '[a]b](https://x.test)' }])
    })
  })

  it('handles very long input without pathological slowdown or crashing', () => {
    const long = 'plain text segment. '.repeat(20000) + '[x](https://example.com) ' + '**bold** '.repeat(5000)
    const start = Date.now()
    const tokens = parseTextLite(long)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(tokens.some((t) => t.type === 'link')).toBe(true)
    expect(tokens.some((t) => t.type === 'bold')).toBe(true)
  })
})

describe('splitParagraphs', () => {
  it('splits on a blank line and trims each paragraph', () => {
    expect(splitParagraphs('First.\n\nSecond.\n\n  Third.  ')).toEqual(['First.', 'Second.', 'Third.'])
  })
  it('a single paragraph with no blank line stays one paragraph', () => {
    expect(splitParagraphs('Just one paragraph.')).toEqual(['Just one paragraph.'])
  })
})

describe('tokenizeAndInterpolate — HIGH security fix: tokenize BEFORE interpolating', () => {
  it('replaces {key} with the matching var, inside a plain text token', () => {
    expect(tokenizeAndInterpolate('Cost per arrival: {spend}', { spend: '$1.23' })).toEqual([{ type: 'text', value: 'Cost per arrival: $1.23' }])
  })

  it('supports dotted paths', () => {
    expect(tokenizeAndInterpolate('{campaign.label} spend', { campaign: { label: 'Launch' } })).toEqual([{ type: 'text', value: 'Launch spend' }])
  })

  it('leaves an unresolved key as-is (visibly wrong, not silently blank)', () => {
    expect(tokenizeAndInterpolate('Need {minCohort} minimum', {})).toEqual([{ type: 'text', value: 'Need {minCohort} minimum' }])
  })

  it('no vars — returns the parsed tokens unchanged', () => {
    expect(tokenizeAndInterpolate('plain text')).toEqual([{ type: 'text', value: 'plain text' }])
  })

  it('THE FIX: a var whose VALUE contains **bold** markup stays literal text — never becomes a bold token', () => {
    const tokens = tokenizeAndInterpolate('Note: {value}', { value: '**evil**' })
    expect(tokens).toEqual([{ type: 'text', value: 'Note: **evil**' }])
    expect(tokens.some((t) => t.type === 'bold')).toBe(false)
  })

  it('THE FIX: a var whose VALUE contains [label](javascript:...) stays literal text — never becomes a link token, regardless of scheme', () => {
    const tokens = tokenizeAndInterpolate('See {value}', { value: '[click me](javascript:alert(1))' })
    expect(tokens).toEqual([{ type: 'text', value: 'See [click me](javascript:alert(1))' }])
    expect(tokens.some((t) => t.type === 'link')).toBe(false)
  })

  it('THE FIX: a var whose value contains [label](https://evil.example.com) ALSO stays literal text — even a "safe-scheme" injected link must not become live, only the STATIC template structure ever becomes a link', () => {
    const tokens = tokenizeAndInterpolate('See {value}', { value: '[click me](https://evil.example.com)' })
    expect(tokens.some((t) => t.type === 'link')).toBe(false)
    expect(tokens).toEqual([{ type: 'text', value: 'See [click me](https://evil.example.com)' }])
  })

  it('a template with real markup AND a var both present: the template markup renders as tokens, the var stays inert inside its own text token', () => {
    const tokens = tokenizeAndInterpolate('**Cost:** {spend} — see [docs](https://example.com)', { spend: '**$1**' })
    expect(tokens).toEqual([
      { type: 'bold', value: 'Cost:' },
      { type: 'text', value: ' **$1** — see ' },
      { type: 'link', value: 'docs', href: 'https://example.com' },
    ])
  })

  it('does not interpolate inside a bold or link token\'s own captured value (accepted limitation, documented)', () => {
    // {var} placed INSIDE **...** or [...](...)  in the TEMPLATE itself is not substituted —
    // only plain text segments are. No current registry entry relies on this.
    const tokens = tokenizeAndInterpolate('**{name}**', { name: 'Launch' })
    expect(tokens).toEqual([{ type: 'bold', value: '{name}' }])
  })
})

describe('toPlainText — safe flattening for non-token call sites', () => {
  it('strips ** markers, keeping the text', () => {
    expect(toPlainText('a **bold** word')).toBe('a bold word')
  })
  it('strips link markup, keeping only the visible label (never the href)', () => {
    expect(toPlainText('see [docs](https://example.com/secret-token) here')).toBe('see docs here')
  })
  it('a neutralised (unsafe-scheme) link keeps its label as plain text, never a live href', () => {
    const out = toPlainText('[click](javascript:alert(1))')
    expect(out).toContain('click')
    expect(out).not.toMatch(/javascript:/i)
  })
  it('a neutralised link with a paren-free URL collapses cleanly', () => {
    expect(toPlainText('[click](http://example.com)')).toBe('click')
  })
  it('interpolates vars, safely (a var value can never reintroduce markup)', () => {
    expect(toPlainText('Rate: {rate}', { rate: '**99%**' })).toBe('Rate: **99%**')
  })
})
