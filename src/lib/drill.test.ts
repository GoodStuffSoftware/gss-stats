import { describe, expect, it } from 'vitest'
import { drillNeedsEventBeacons, nativeField, semanticKey } from './drill'

// See the doc comment on drillNeedsEventBeacons: without carrying includeEventBeacons forward,
// a drill into an event-family pathFamily value (e.g. 'install') opens a filtered page whose
// OTHER widgets would combine the standing event-beacon exclusion with the new pathFamily
// constraint — a combination that can never match a row — and render silently empty.
describe('drillNeedsEventBeacons', () => {
  it('true for a geo pathFamily drill into a real event family', () => {
    for (const family of ['install', 'popup-outcome', 'return', 'game-complete', 'signin-prompt', 'signin-eligible', 'promo-first50', 'first50-congrats', 'upsell', 'auth-status']) {
      expect(drillNeedsEventBeacons('pathFamily', 'geo', family)).toBe(true)
    }
  })

  it('false for a geo pathFamily drill into "page" (an ordinary page view, not an event)', () => {
    expect(drillNeedsEventBeacons('pathFamily', 'geo', 'page')).toBe(false)
  })

  it('false for any other dimension, even on geo (no other dimension\'s values are event-specific)', () => {
    expect(drillNeedsEventBeacons('device', 'geo', 'mobile')).toBe(false)
    expect(drillNeedsEventBeacons('region', 'geo', 'CA')).toBe(false)
    expect(drillNeedsEventBeacons('screenwBucket', 'geo', '<480')).toBe(false)
    expect(drillNeedsEventBeacons('path', 'geo', '/install/play')).toBe(false) // path itself, not pathFamily
  })

  it('false for pathFamily on the rum dataset (pathFamily does not exist there — semanticKey/nativeField already gate this, this is defense in depth)', () => {
    expect(drillNeedsEventBeacons('pathFamily', 'rum', 'install')).toBe(false)
  })

  it('sanity: pathFamily round-trips through semanticKey/nativeField for geo, matching what App.vue\'s openFilteredPage actually computes', () => {
    expect(semanticKey('pathFamily', 'geo')).toBe('pathFamily')
    expect(nativeField('pathFamily', 'geo')).toBe('pathFamily')
    expect(nativeField('pathFamily', 'rum')).toBeNull()
  })
})
