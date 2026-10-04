import { describe, expect, it } from 'vitest'
import { VALUE_TOKEN_PLACEHOLDER, parseTextLite, splitParagraphs, tokenizeAndInterpolate, toPlainText } from './textLite'

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

  describe('HIGH follow-up fix — control characters/whitespace stripped from the WHOLE href before classifying, not just trimmed', () => {
    // A naive scheme check misses these because .trim() only strips the two ends, and
    // browsers strip ASCII tab/newline/CR from a URL before parsing its scheme — so each of
    // these reads as "not javascript:" to a pattern match but IS a live javascript: URL to
    // the browser.
    it('a tab inside the scheme (java\\tscript:) is neutralised, not treated as a safe relative path', () => {
      const tokens = parseTextLite('[x](java\tscript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('a newline inside the scheme (java\\nscript:) is neutralised', () => {
      const tokens = parseTextLite('[x](java\nscript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
    })
    it('a CR inside the scheme (java\\rscript:) is neutralised', () => {
      const tokens = parseTextLite('[x](java\rscript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
    })
    it('a leading \\u0001 control character is neutralised, not treated as an opaque-but-harmless prefix', () => {
      const tokens = parseTextLite('[x](\u0001javascript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
    })
    it('a leading \\u0000 (NUL) before javascript: is neutralised', () => {
      const tokens = parseTextLite('[x](\u0000javascript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
    })
    it('an HTML-entity-encoded tab ("jav&#x09;ascript:") is never decoded — it stays inert text because we never interpret entities, so the raw "&#x09;" characters just fail the charset allowlist', () => {
      const tokens = parseTextLite('[x](jav&#x09;ascript:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('a backslash after the leading slash (/\\\\evil.com) is neutralised — some URL parsers treat /\\ as protocol-relative, same as //', () => {
      const tokens = parseTextLite('[x](/\\evil.com)')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('protocol-relative //evil.com is neutralised (regression: every one of its characters is individually charset-legal, so the bare-relative-path branch must never see it)', () => {
      const tokens = parseTextLite('[x](//evil.com)')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('a schemeless-looking "https:evil.com" (no //) is neutralised — some URL parsers normalize this to https://evil.com, so only the literal "https://" prefix form is ever accepted', () => {
      const tokens = parseTextLite('[x](https:evil.com)')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
      expect(tokens[0]).toEqual({ type: 'text', value: 'x' })
    })
    it('mixed control characters and case together (\\u0001 + JaVaScRiPt with an embedded tab) are still neutralised', () => {
      const tokens = parseTextLite('[x](\u0001Ja\tVaScRiPt:alert(1))')
      expect(tokens.some((t) => t.type === 'link')).toBe(false)
    })
    it('a safe https:// URL survives normalization unchanged when it has no control characters', () => {
      expect(parseTextLite('[x](https://example.com/y)')).toEqual([{ type: 'link', value: 'x', href: 'https://example.com/y' }])
    })
    it('the RENDERED href is the normalized value, not the raw one — a safe URL with a stray embedded tab is stripped down to the clean href rather than rejected outright', () => {
      const tokens = parseTextLite('[x](https://exa\tmple.com/y)')
      expect(tokens).toEqual([{ type: 'link', value: 'x', href: 'https://example.com/y' }])
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

// Slice 1c: a `{=…}` value token (1d "Insert value") shows a dash on this build, never its raw text.
describe('value tokens {=…} (placeholder until 1d)', () => {
  it('renders every value token as an em dash, with or without vars', () => {
    expect(VALUE_TOKEN_PLACEHOLDER).toBe('—')
    expect(toPlainText('Arrivals: {=campaign.taggedArrivals}, rate {=rate:d0}.')).toBe('Arrivals: —, rate —.')
    expect(toPlainText('Spend {=spend} for {name}', { name: 'Launch' })).toBe('Spend — for Launch')
    expect(toPlainText('{=}')).toBe('—')
  })

  it('inside bold and a link label too; a link whose URL holds one is plain text, never an href', () => {
    expect(tokenizeAndInterpolate('**{=x}** and [see {=y}](https://example.com/{=z})')).toEqual([
      { type: 'bold', value: '—' },
      { type: 'text', value: ' and ' },
      { type: 'text', value: 'see —' },
    ])
    expect(tokenizeAndInterpolate('[a {=y}](https://example.com/ok)')).toEqual([{ type: 'link', value: 'a —', href: 'https://example.com/ok' }])
    for (const src of ['[x](/p{=a})', '[x]({=a})', '[x](#{=a})', '[x](docs/{=a}.md)'])
      expect(tokenizeAndInterpolate(src), src).toEqual([{ type: 'text', value: 'x' }])
  })

  it('a token that wraps markup is one dash, never its raw text (NIT-2)', () => {
    expect(tokenizeAndInterpolate('a {=**x**} b')).toEqual([{ type: 'text', value: 'a — b' }])
    expect(tokenizeAndInterpolate('{=[a](https://x.test)}')).toEqual([{ type: 'text', value: '—' }])
    expect(toPlainText('see {=**x**} and **{=y}**')).toBe('see — and —')
    expect(toPlainText('Rate {=[r](/p)} for {name}', { name: 'Launch' })).toBe('Rate — for Launch')
  })

  it('an href with a brace is never a link, value token or not (NIT-3)', () => {
    for (const src of ['[x](https://a.test/{b})', '[x](/p{)', '[x](/p})', '[x](https://a.test/{=)'])
      expect(parseTextLite(src), src).toEqual([{ type: 'text', value: 'x' }])
    expect(parseTextLite('[x](https://a.test/b)')).toEqual([{ type: 'link', value: 'x', href: 'https://a.test/b' }])
  })

  it('a var whose value looks like a value token is left as the var says', () => {
    expect(toPlainText('{a}', { a: '{=b}' })).toBe('{=b}')
  })

  it('leaves ordinary {vars} placeholders and unbalanced braces alone', () => {
    expect(toPlainText('Keep {unknown} and {= open')).toBe('Keep {unknown} and {= open')
  })
})
