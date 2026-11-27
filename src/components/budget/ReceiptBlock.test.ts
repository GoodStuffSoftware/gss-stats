// @vitest-environment happy-dom
// The Receipt block draws email-derived text, so every field gets hostile strings: none may become markup or a link.
// Made-up data only (example.com, made-up stores and amounts).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReceiptBlock from './ReceiptBlock.vue'
import { gmailUrl, receiptSummary, receiptText } from '../../lib/budget/tableModel'
import type { ReceiptLink } from '../../lib/budget/receiptsClient'

const GOOD_ID = '18c0ffee12345678'
const HOSTILE = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '"><a href="https://evil.example.com">x</a>',
  'a‮evil‬b⁦c⁩',
  '[click](https://evil.example.com) **bold** `code`',
  'x'.repeat(10_000),
]

function link(over: Partial<ReceiptLink> = {}): ReceiptLink {
  return {
    merchant: 'Corner Shop',
    date: '2024-10-05',
    totalCents: 1234,
    taxCents: 98,
    currency: 'USD',
    orderRef: 'ORD-1001',
    cardLast4: '4242',
    items: [
      { description: 'Widget', quantity: 2, amountCents: 500, categoryId: null, category: null },
      { description: 'Gadget', quantity: 1, amountCents: 636, categoryId: null, category: null },
    ],
    ...over,
  }
}
const mountBlock = (l: ReceiptLink) => mount(ReceiptBlock, { props: { link: l } })

describe('ReceiptBlock fields', () => {
  it('shows store, date, total, tax, order, card and items', () => {
    const w = mountBlock(link())
    expect(w.get('[data-testid="receipt-merchant"]').text()).toBe('Corner Shop')
    expect(w.get('[data-testid="receipt-date"]').text()).toBe('Oct 5, 2024')
    expect(w.get('[data-testid="receipt-total"]').text()).toBe('$12.34')
    expect(w.get('[data-testid="receipt-tax"]').text()).toBe('$0.98')
    expect(w.get('[data-testid="receipt-order"]').text()).toBe('ORD-1001')
    expect(w.get('[data-testid="receipt-card"]').text()).toBe('ending 4242')
    const items = w.findAll('[data-testid="receipt-items"] li').map((l) => l.text())
    expect(items).toEqual(['Widget × 2$5.00', 'Gadget$6.36'])
  })
  it('leaves out what is missing and caps the item list', () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ description: `Item ${n}`, quantity: null, amountCents: 100, categoryId: null, category: null }))
    const w = mountBlock(link({ merchant: null, date: null, taxCents: null, orderRef: null, cardLast4: null, items: many }))
    expect(w.find('[data-testid="receipt-merchant"]').exists()).toBe(false)
    expect(w.find('[data-testid="receipt-tax"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="receipt-items"] li')).toHaveLength(9)
    expect(w.get('.rb-more').text()).toBe('+4 more')
  })
  it('survives a malformed link object', () => {
    const w = mountBlock({ merchant: 5, items: 'nope', totalCents: 'x' } as unknown as ReceiptLink)
    expect(w.find('[data-testid="receipt-block"]').exists()).toBe(true)
    expect(w.find('a').exists()).toBe(false)
  })
})

describe('ReceiptBlock hostile strings', () => {
  for (const bad of HOSTILE) {
    it(`renders ${JSON.stringify(bad.slice(0, 30))} as text only, in every field`, () => {
      const w = mountBlock(
        link({
          merchant: bad,
          date: bad,
          orderRef: bad,
          cardLast4: bad,
          items: [{ description: bad, quantity: 1, amountCents: 100, categoryId: bad, category: bad }],
        }),
      )
      expect(w.find('script').exists()).toBe(false)
      expect(w.find('img').exists()).toBe(false)
      expect(w.find('a').exists()).toBe(false)
      expect(w.find('code').exists()).toBe(false)
      expect(w.find('strong').exists()).toBe(false)
      expect(w.html()).not.toMatch(/<(script|img|a)[\s>]/i)
      // no field text outgrows its cap (10k characters become a short ellipsised line)
      expect(w.text().length).toBeLessThan(600)
      expect(w.text()).not.toMatch(/[‪-‮⁦-⁩]/)
    })
  }
  it('keeps angle brackets as visible text', () => {
    const w = mountBlock(link({ merchant: '<script>alert(1)</script>' }))
    expect(w.get('[data-testid="receipt-merchant"]').text()).toBe('<script>alert(1)</script>')
  })
  it('a hostile currency code cannot break the amounts', () => {
    const w = mountBlock(link({ currency: '"><x' }))
    expect(w.get('[data-testid="receipt-total"]').text()).toBe('$12.34')
  })
})

describe('Open in Gmail link', () => {
  it('appears for a valid id, with the safe attributes and an opaque URL', () => {
    const w = mountBlock(link({ gmailMsgId: GOOD_ID }))
    const a = w.get('a[data-testid="receipt-gmail"]')
    expect(a.attributes('href')).toBe(`https://mail.google.com/mail/#all/${GOOD_ID}`)
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
    expect(a.text()).toBe('Open in Gmail')
  })
  it('is absent when the id is missing (the other person, or none mode)', () => {
    expect(mountBlock(link()).find('a').exists()).toBe(false)
  })
  const BAD_IDS = ['', 'abc', 'XYZ12345', GOOD_ID.toUpperCase(), GOOD_ID + '/../x', 'a'.repeat(33), '18c0ffee 1234', 'javascript:alert(1)', '"><a', 'x@example.com', 123 as unknown as string]
  for (const id of BAD_IDS) {
    it(`gives no link for the id ${JSON.stringify(id)}`, () => {
      expect(mountBlock(link({ gmailMsgId: id })).find('a').exists()).toBe(false)
      expect(gmailUrl(id)).toBeNull()
    })
  }
})

describe('View photo', () => {
  it('shows only when imageUrl is set, and opens the photo in the shared modal', async () => {
    const none = mountBlock(link({ source: 'upload', hasImage: true }))
    expect(none.find('[data-testid="receipt-photo-btn"]').exists()).toBe(false)
    const w = mount(ReceiptBlock, { props: { link: link({ source: 'upload', hasImage: true, imageUrl: '/api/budget/uploads/r1/image' }) }, attachTo: document.body })
    const btn = w.find('[data-testid="receipt-photo-btn"]')
    expect(btn.text()).toBe('View photo')
    expect(document.querySelector('[data-testid="receipt-photo-img"]')).toBeNull()
    await btn.trigger('click')
    const img = document.querySelector('[data-testid="receipt-photo-img"]') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/budget/uploads/r1/image')
    w.unmount()
  })
  it('ignores an imageUrl that is not an uploads path', () => {
    const w = mountBlock(link({ imageUrl: 'https://evil.example.com/x.jpg' }))
    expect(w.find('[data-testid="receipt-photo-btn"]').exists()).toBe(false)
  })
})

describe('receipt text helpers', () => {
  it('receiptText strips control and bidi characters, collapses space and caps length', () => {
    expect(receiptText('a‮b\u0000c\n\nd  e')).toBe('ab c d e')
    expect(receiptText('x'.repeat(500), 40)).toHaveLength(40)
    expect(receiptText(42)).toBe('')
  })
  it('receiptSummary is "Receipt: store · total", shortened when a part is missing', () => {
    expect(receiptSummary(link())).toBe('Receipt: Corner Shop · $12.34')
    expect(receiptSummary(link({ merchant: null }))).toBe('Receipt: $12.34')
    expect(receiptSummary(link({ merchant: null, totalCents: null }))).toBe('Receipt')
  })
})
