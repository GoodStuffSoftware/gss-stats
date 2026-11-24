// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownText from './MarkdownText.vue'

const render = (text: string, inline = false) => mount(MarkdownText, { props: { text, inline } })

describe('MarkdownText', () => {
  const corpus = ['*', '#1', '# not a heading', '5 * 3', 'a_b_c', '<b>x</b>', '[x]', 'https://example.com']
  for (const note of corpus) {
    it(`renders its own text: ${note}`, () => {
      const w = render(note)
      expect(w.text()).toBe(note)
      expect(w.find('b').exists()).toBe(false)
    })
  }

  it('a bare address is a link with the same text', () => {
    const a = render('https://example.com').find('a')
    expect(a.text()).toBe('https://example.com')
    expect(a.attributes('href')).toBe('https://example.com')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
  })

  it('unsafe links and html render as inert text', () => {
    for (const note of ['[x](javascript:alert(1))', '[x](data:text/html,hi)', '[x](//evil.com)', '[x](java\tscript:alert(1))']) {
      const w = render(note)
      expect(w.find('a').exists()).toBe(false)
      expect(w.text()).toBe('x')
    }
    const w = render('<script>alert(1)</script>')
    expect(w.find('script').exists()).toBe(false)
    expect(w.text()).toBe('<script>alert(1)</script>')
  })

  it('lists, bold, italic and code', () => {
    const w = render('**b** *i* `c`\n- one\n- two\n\n1. x\n2. y')
    expect(w.find('strong').text()).toBe('b')
    expect(w.find('em').text()).toBe('i')
    expect(w.find('code').text()).toBe('c')
    expect(w.findAll('ul li').map((l) => l.text())).toEqual(['one', 'two'])
    expect(w.findAll('ol li').map((l) => l.text())).toEqual(['x', 'y'])
  })

  it('line breaks', () => {
    const w = render('a\nb')
    expect(w.findAll('p')).toHaveLength(1)
    expect(w.findAll('br')).toHaveLength(1)
  })

  it('inline mode flattens lists and paragraphs', () => {
    const w = render('intro\n- one\n- two\n\nlast **b**', true)
    expect(w.find('p').exists()).toBe(false)
    expect(w.find('ul').exists()).toBe(false)
    expect(w.find('br').exists()).toBe(false)
    expect(w.text()).toBe('intro • one • two last b')
    expect(w.find('strong').text()).toBe('b')
  })
})
