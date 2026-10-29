// @vitest-environment happy-dom
//
// CaptionCollapse: the notes region with a widget's captionDisplay applied. happy-dom does no
// layout, so a stub gives the text element a height: tall (100px) unless it is folded, and then
// as tall as two lines (32px), which is what the browser reports for text that runs past them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import CaptionCollapse from './CaptionCollapse.vue'
import captionCollapseSrc from './CaptionCollapse.vue?raw'
import NoteBlock from './NoteBlock.vue'
import { CAPTION_AUTO_CHARS } from '../lib/captionDisplay'
import type { CaptionDisplay } from '../types'

const proto = HTMLElement.prototype as unknown as Record<string, unknown>
let tall = true
const saved = { scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'), clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight') }
const mounted: VueWrapper[] = []
beforeEach(() => {
  tall = true
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => (tall ? 100 : 20) })
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('cc-folded') ? 32 : tall ? 100 : 20
    },
  })
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(proto, k, d)
    else delete proto[k]
  }
})

const LONG = 'A long explanation of how this number is counted. '.repeat(8).trim() // > 250 chars
const SHORT = 'Counts every visit.'
function mountRegion(mode: CaptionDisplay | undefined, texts: string[]) {
  const w = mount(CaptionCollapse, {
    props: { mode },
    slots: { default: () => texts.map((t) => h(NoteBlock, { text: t })) },
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
const toggle = (w: VueWrapper) => w.find('[data-testid="caption-toggle"]')
const body = (w: VueWrapper) => w.get('[data-testid="caption-body"]')

describe('CaptionCollapse', () => {
  it('LONG is over the auto threshold and SHORT is not', () => {
    expect(LONG.length).toBeGreaterThan(CAPTION_AUTO_CHARS)
    expect(SHORT.length).toBeLessThan(CAPTION_AUTO_CHARS)
  })

  it.each<[string, CaptionDisplay | undefined]>([
    ['no value', undefined],
    ['always', 'always'],
  ])('%s: the text shows in full, with no button', async (_n, mode) => {
    const w = mountRegion(mode, [LONG])
    await w.vm.$nextTick()
    expect(body(w).classes()).not.toContain('cc-folded')
    expect(body(w).classes()).not.toContain('cc-folding')
    expect(toggle(w).exists()).toBe(false)
    expect(w.text()).toContain(LONG)
  })

  it('collapsible: long text folds with a "Show more" button; it opens in place and folds back', async () => {
    const w = mountRegion('collapsible', [LONG])
    await w.vm.$nextTick()
    expect(body(w).classes()).toContain('cc-folded')
    const btn = toggle(w)
    expect(btn.element.tagName).toBe('BUTTON')
    expect(btn.attributes('type')).toBe('button')
    expect(btn.text()).toBe('Show more')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-controls')).toBe(body(w).attributes('id'))
    expect(w.text()).toContain(LONG) // folded by style only: the full text stays in the page for print and a screen reader

    await btn.trigger('click')
    expect(body(w).classes()).not.toContain('cc-folded')
    expect(toggle(w).text()).toBe('Show less')
    expect(toggle(w).attributes('aria-expanded')).toBe('true')

    await toggle(w).trigger('click')
    expect(body(w).classes()).toContain('cc-folded')
    expect(toggle(w).text()).toBe('Show more')
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
  })

  it('collapsible: text that fits in two lines gets no button', async () => {
    tall = false
    const w = mountRegion('collapsible', [SHORT])
    await w.vm.$nextTick()
    expect(toggle(w).exists()).toBe(false)
    expect(body(w).classes()).not.toContain('cc-faded') // no fade without a button to undo it
  })

  it('collapsible: text that overflows is faded, and the fade goes when it is opened', async () => {
    const w = mountRegion('collapsible', [LONG])
    await w.vm.$nextTick()
    expect(body(w).classes()).toContain('cc-faded')
    await toggle(w).trigger('click')
    expect(body(w).classes()).not.toContain('cc-faded')
  })

  it('auto: folds only once the text is over the threshold', async () => {
    const short = mountRegion('auto', [SHORT])
    await short.vm.$nextTick()
    expect(body(short).classes()).not.toContain('cc-folded')
    expect(toggle(short).exists()).toBe(false)

    const long = mountRegion('auto', [LONG])
    await long.vm.$nextTick()
    expect(body(long).classes()).toContain('cc-folded')
    expect(toggle(long).text()).toBe('Show more')
  })

  it('the notes count together: several short notes whose total is over the threshold fold under auto', async () => {
    const parts = ['From 2026-10-16 (v1.99.2): sign-ins can be tied to the first ad touch, so the count rises.', 'Release 1.103.0 moved cancels.', 'Whole days only.']
    expect(parts.every((p) => p.length < CAPTION_AUTO_CHARS)).toBe(true)
    const one = mountRegion('auto', parts)
    await one.vm.$nextTick()
    expect(body(one).classes()).not.toContain('cc-folded') // together still under the threshold
    const notes = [...parts, ...parts, ...parts]
    expect(notes.join('').length).toBeGreaterThan(CAPTION_AUTO_CHARS)
    const w = mountRegion('auto', notes)
    await w.vm.$nextTick()
    expect(body(w).classes()).toContain('cc-folded')
    expect(w.findAll('.note-block')).toHaveLength(9)
  })

  it('the button is reachable by keyboard: a native, enabled button with no negative tabindex', async () => {
    const w = mountRegion('collapsible', [LONG])
    await w.vm.$nextTick()
    expect(toggle(w).attributes('tabindex')).toBeUndefined()
    expect(toggle(w).attributes('disabled')).toBeUndefined()
  })

  it('print shows the full text: the folded style and the button are overridden in a print block', () => {
    const src = captionCollapseSrc
    const print = src.slice(src.indexOf('@media print'))
    expect(print).toMatch(/\.cc-folded\s*{[^}]*max-height:\s*none/)
    expect(print).toMatch(/\.cc-folded\s*{[^}]*overflow:\s*visible/)
    expect(print).toMatch(/\.cc-faded\s*{[^}]*mask-image:\s*none/)
    expect(print).toMatch(/\.cc-toggle\s*{[^}]*display:\s*none/)
  })
})
