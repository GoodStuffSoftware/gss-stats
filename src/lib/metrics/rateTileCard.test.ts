// The mapping of a legacy pop-up rate tile onto a one-item card (ADR 0005 slice 4): every
// POPUP_RATE_SPECS key maps to a registered ratio, the widget is never written to, and what is not
// a known rate tile has no card.
import { describe, expect, it } from 'vitest'
import { POPUP_RATE_SPECS } from '../popupEvents'
import { rateTileCardRef, isLegacyRateTile } from './rateTileCard'
import { cardRefFor } from './readingsCard'
import { RATIOS } from './ratios'
import { validateCard } from './validate'
import type { Widget } from '../../types'

const rate = (dimension: string, extra: Partial<Widget> = {}): Widget => ({ id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension, metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3, ...extra })

describe('rateTileCardRef', () => {
  it('a stored hide of popup-note hides the install-fix note on the tile (and only then); the card still validates', () => {
    const item = (w: Widget) => (rateTileCardRef(w) as { spec: { sections: { items: { hideNotes?: string[] }[] }[] } }).spec.sections[0].items[0]
    expect(item(rate('install:outcome:installed')).hideNotes).toBeUndefined()
    expect(item(rate('install:outcome:installed', { hiddenCaveats: ['other'] })).hideNotes).toBeUndefined()
    expect(item(rate('install:outcome:installed', { hiddenCaveats: ['popup-note'] })).hideNotes).toEqual(['install-fix-note'])
    expect(validateCard((rateTileCardRef(rate('upsell:tap', { hiddenCaveats: ['popup-note'] })) as { spec: never }).spec)).toEqual([])
  })

  it('maps each of the 22 keys to a one-tile card on a registered ratio with the key\'s own label', () => {
    expect(POPUP_RATE_SPECS).toHaveLength(22)
    for (const s of POPUP_RATE_SPECS) {
      const ref = rateTileCardRef(rate(s.key))
      expect(ref, s.key).not.toBeNull()
      const spec = (ref as { spec: { sections: { layout: string; items: { label: string; data: { ratio: string }; display: unknown; frame: string }[] }[] } }).spec
      expect(spec.sections).toHaveLength(1)
      expect(spec.sections[0].layout).toBe('tiles')
      expect(spec.sections[0].items).toHaveLength(1)
      const item = spec.sections[0].items[0]
      expect(RATIOS.has(item.data.ratio), s.key).toBe(true)
      expect(item.label).toBe(s.label)
      expect(item.display).toEqual({ as: 'percent', decimals: 1 })
      expect(item.frame).toBe('tile')
    }
  })

  it('reads the right ratio and pop-up for each kind', () => {
    const item = (key: string) => (rateTileCardRef(rate(key)) as { spec: { sections: { items: { data: unknown }[] }[] } }).spec.sections[0].items[0].data
    expect(item('upsell:tap')).toEqual({ ratio: 'popup.tapRate', params: { popup: 'upsell' }, window: 'page' })
    expect(item('signin-prompt:outcome:signed-in')).toEqual({ ratio: 'popup.signedInRate', params: { popup: 'signin-prompt' }, window: 'page' })
    expect(item('install:outcome:installed')).toEqual({ ratio: 'popup.installedRate', params: { popup: 'install' }, window: 'page' })
    expect(item('promo-first50:outcome:returned')).toEqual({ ratio: 'popup.returnedRate', params: { popup: 'promo-first50' }, window: 'page' })
    expect(item('install:outcome:still-playing')).toEqual({ ratio: 'popup.stillPlayingRate', params: { popup: 'install' }, window: 'page' })
    expect(item('signin-eligible:rate')).toEqual({ ratio: 'popup.eligibility', window: 'page' })
  })

  it('every mapped card is one the engine accepts', () => {
    for (const s of POPUP_RATE_SPECS) {
      const ref = rateTileCardRef(rate(s.key)) as { spec: unknown }
      expect(validateCard(ref.spec as never), s.key).toEqual([])
    }
  })

  it('has no card for an unknown key, a non-popup rate or another widget type', () => {
    expect(rateTileCardRef(rate('nope:tap'))).toBeNull()
    expect(rateTileCardRef(rate(''))).toBeNull()
    expect(rateTileCardRef(rate('upsell:tap', { dataset: 'geo' }))).toBeNull()
    expect(rateTileCardRef(rate('upsell:tap', { type: 'stat' }))).toBeNull()
  })

  it('leaves a rate tile that already has its own card alone', () => {
    const own = { preset: 'popup-rates' }
    expect(isLegacyRateTile(rate('upsell:tap', { card: own }))).toBe(false)
    expect(cardRefFor(rate('upsell:tap', { card: own }))).toBe(own)
  })

  it('cardRefFor never writes to the widget, and the stored fields stay readable for a rollback', () => {
    const w = rate('upsell:tap')
    const before = JSON.stringify(w)
    expect(cardRefFor(w)).not.toBeNull()
    expect(JSON.stringify(w)).toBe(before)
    expect(w.card).toBeUndefined()
  })
})
