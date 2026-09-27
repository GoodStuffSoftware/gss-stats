// @vitest-environment happy-dom
//
// ChartEditor.vue as a modal dialog (review fix, 2026-09-27): role="dialog"/aria-modal, named by
// its own heading; focus moves to the Title field on open; Tab/Shift+Tab are trapped inside;
// Esc cancels; focus returns to whatever opened it once it closes. Every element under test is
// attached to document.body (attachTo) — document.activeElement only tracks real DOM attachment,
// not a detached test-utils tree.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import type { Widget } from '../types'

const mounted: VueWrapper[] = []
const widget: Widget = { id: 'w1', i: 'w1', title: 'A chart', type: 'bar', dataset: undefined, dimension: 'requestHost', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 8 }

function mountEditor() {
  const w = mount(ChartEditor, { props: { widget, isNew: false }, attachTo: document.body })
  mounted.push(w)
  return w
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('dialog semantics', () => {
  it('the panel is a labelled, modal dialog', () => {
    const w = mountEditor()
    const panel = w.find('.panel')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    const labelledBy = panel.attributes('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const heading = document.getElementById(labelledBy!)
    expect(heading?.textContent).toBe('Edit chart')
  })

  it('"Add chart" names the dialog "Add chart" too, not a fixed string', () => {
    const w = mount(ChartEditor, { props: { widget, isNew: true }, attachTo: document.body })
    mounted.push(w)
    const panel = w.find('.panel')
    const heading = document.getElementById(panel.attributes('aria-labelledby')!)
    expect(heading?.textContent).toBe('Add chart')
  })
})

describe('focus management', () => {
  it('moves focus to the Title field on open', () => {
    mountEditor()
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Chart title')
  })

  it('Esc cancels', async () => {
    const w = mountEditor()
    await w.find('.panel').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('cancel')).toBeTruthy()
  })

  it('returns focus to whatever opened it once it closes', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Edit'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const w = mountEditor()
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Chart title') // moved away while open
    w.unmount()
    mounted.pop()
    expect(document.activeElement).toBe(opener) // back to the opener
    opener.remove()
  })

  it('Tab from the last focusable element wraps to the first; Shift+Tab from the first wraps to the last', async () => {
    const w = mountEditor()
    const panel = w.find('.panel')
    const focusable = panel.element.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const visible = [...focusable].filter((el) => el.offsetParent !== null || el === document.activeElement)
    const first = visible[0]
    const last = visible[visible.length - 1]

    last.focus()
    expect(document.activeElement).toBe(last)
    await panel.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first) // wrapped, never escaped to the page behind it

    first.focus()
    await panel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
