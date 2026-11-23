// @vitest-environment happy-dom
// "Change similar purchases?": the switch default and flip, the rule box and its lock, the count, Esc. Made-up rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import SimilarDialog from './SimilarDialog.vue'
import { defaultTxnViewPrefs, withSameAmount } from '../../lib/budget/txnView'
import type { Category, SimilarResponse, SimilarRow } from '../../lib/budget/types'

class FakeObserver {
  observe() {}
  disconnect() {}
}
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 })
  vi.stubGlobal('ResizeObserver', FakeObserver)
})
let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})

const categories: Category[] = [
  { id: 'home', label: 'Home Projects', color: null, sort: 1 },
  { id: 'fun', label: 'Fun', color: null, sort: 2 },
]
const row = (o: Partial<SimilarRow> & { id: string }): SimilarRow => ({
  postedDate: '2026-01-05', amountCents: -2399, merchantName: 'Acme Hardware', description: 'ACME', accountId: 'a1', kind: 'spending',
  categoryId: 'fun', categorySource: 'rule', updatedAt: `t-${o.id}`, note: null, personSet: false, scriptSet: false, sameAmount: true, suggestTick: true, ...o,
}) as SimilarRow
function offer(o: Partial<SimilarResponse> = {}) {
  const response: SimilarResponse = {
    source: { id: 's', merchantKey: 'acme', amountCents: -2399, categoryId: 'home' },
    mixed: false, mixedReasons: [], truncated: false, ruleOffer: { allowed: true },
    rows: [row({ id: 'a' }), row({ id: 'b', sameAmount: false, amountCents: -500 }), row({ id: 'c', personSet: true, suggestTick: false })],
    ...o,
  }
  return { sourceId: 's', categoryId: 'home', response }
}
function mountDialog(props: Record<string, unknown> = {}) {
  wrapper = mount(SimilarDialog as never, {
    props: { offer: offer(), categories, prefs: defaultTxnViewPrefs(), ...props },
    attachTo: document.body,
  } as never) as unknown as VueWrapper
  return wrapper
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel)
const applyText = () => q('[data-testid="sd-apply"]')!.textContent!.trim()

describe('SimilarDialog', () => {
  it('shows the title, the count of ticked rows and pre-ticks the suggested ones', async () => {
    mountDialog()
    await nextTick()
    expect(q('#sd-title')!.textContent).toContain('Change similar purchases?')
    expect(document.querySelectorAll('[data-testid="select-row"]')).toHaveLength(3)
    expect(applyText()).toBe('Change 2')
    expect(q('[data-testid="sd-desc"]')!.textContent).toContain('3 other purchases from Acme Hardware are not in Home Projects')
  })
  it('the switch starts on for a mixed merchant, hides the rule box when not allowed, and flips with a prefs event', async () => {
    const w = mountDialog({ offer: offer({ mixed: true, ruleOffer: { allowed: false } }) })
    await nextTick()
    const sw = q<HTMLInputElement>('[data-testid="sd-same-amount"]')!
    expect(sw.checked).toBe(true)
    expect(document.querySelectorAll('[data-testid="select-row"]')).toHaveLength(2)
    expect(q('[data-testid="sd-rule"]')).toBeNull()
    expect(q('[data-testid="sd-mixed"]')).not.toBeNull()
    sw.checked = false
    sw.dispatchEvent(new Event('change'))
    await nextTick()
    expect(w.emitted('flip')?.[0]).toEqual(['acme', false])
    expect(document.querySelectorAll('[data-testid="select-row"]')).toHaveLength(3)
  })
  it('an ordinary merchant has no same-amount switch and lists every purchase, even with a stale saved choice', async () => {
    mountDialog({ prefs: withSameAmount(defaultTxnViewPrefs(), 'acme', true) })
    await nextTick()
    expect(q('[data-testid="sd-same-amount"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="select-row"]')).toHaveLength(3)
  })
  it('a saved choice wins over the mixed default', async () => {
    mountDialog({ offer: offer({ mixed: true }), prefs: withSameAmount(defaultTxnViewPrefs(), 'acme', false) })
    await nextTick()
    expect(q<HTMLInputElement>('[data-testid="sd-same-amount"]')!.checked).toBe(false)
  })
  it('the rule box ticks and locks rows nobody chose by hand, and sends makeRule', async () => {
    const w = mountDialog({ offer: offer({ rows: [row({ id: 'a', suggestTick: false }), row({ id: 'p', personSet: true, suggestTick: false })] }) })
    await nextTick()
    expect(applyText()).toBe('Change 0')
    expect(q<HTMLButtonElement>('[data-testid="sd-apply"]')!.disabled).toBe(true)
    const rule = q<HTMLInputElement>('[data-testid="sd-rule"]')!
    rule.checked = true
    rule.dispatchEvent(new Event('change'))
    await nextTick()
    const boxes = document.querySelectorAll<HTMLInputElement>('[data-testid="select-row"]')
    expect(boxes[0].checked && boxes[0].disabled).toBe(true)
    expect(boxes[1].checked || boxes[1].disabled).toBe(false)
    q('[data-testid="sd-apply"]')!.click()
    expect(w.emitted('apply')?.[0]).toEqual([[{ id: 'a', expectedUpdatedAt: 't-a' }], true])
  })
  it('Apply sends only the ticked visible rows with their updatedAt', async () => {
    const w = mountDialog()
    await nextTick()
    q('[data-testid="sd-apply"]')!.click()
    expect(w.emitted('apply')?.[0]).toEqual([[{ id: 'a', expectedUpdatedAt: 't-a' }, { id: 'b', expectedUpdatedAt: 't-b' }], false])
  })
  it('shows the newest-300 note when truncated and the hand badge on a person-set row', async () => {
    mountDialog({ offer: offer({ truncated: true }) })
    await nextTick()
    expect(q('[data-testid="sd-truncated"]')!.textContent).toContain('Showing the newest 300.')
    expect(document.body.textContent).toContain('Set by hand')
  })
  it('Esc and Not now close with no apply', async () => {
    const w = mountDialog()
    await nextTick()
    q('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    q('[data-testid="sd-cancel"]')!.click()
    expect(w.emitted('close')).toHaveLength(2)
    expect(w.emitted('apply')).toBeUndefined()
  })
})
