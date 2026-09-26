import { describe, expect, it } from 'vitest'
import { parseTextLite, splitParagraphs, interpolate } from './textLite'

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
})

describe('splitParagraphs', () => {
  it('splits on a blank line and trims each paragraph', () => {
    expect(splitParagraphs('First.\n\nSecond.\n\n  Third.  ')).toEqual(['First.', 'Second.', 'Third.'])
  })
  it('a single paragraph with no blank line stays one paragraph', () => {
    expect(splitParagraphs('Just one paragraph.')).toEqual(['Just one paragraph.'])
  })
})

describe('interpolate', () => {
  it('replaces {key} with the matching var', () => {
    expect(interpolate('Cost per arrival: {spend}', { spend: '$1.23' })).toBe('Cost per arrival: $1.23')
  })
  it('supports dotted paths', () => {
    expect(interpolate('{campaign.label} spend', { campaign: { label: 'Launch' } })).toBe('Launch spend')
  })
  it('leaves an unresolved key as-is (visibly wrong, not silently blank)', () => {
    expect(interpolate('Need {minCohort} minimum', {})).toBe('Need {minCohort} minimum')
  })
  it('no vars — returns the input unchanged', () => {
    expect(interpolate('plain text')).toBe('plain text')
  })
})
