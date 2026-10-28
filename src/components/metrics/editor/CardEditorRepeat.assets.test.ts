// @vitest-environment happy-dom
//
// The repeat picker offers the ad-asset axis (RepeatSpec.over 'assets') wherever the campaign axis is
// offered, and its three settings (campaign, order by, show at most) are saved on the spec.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CardEditorRepeat from './CardEditorRepeat.vue'
import CardEditor from '../CardEditor.vue'
import CardEditorData from './CardEditorData.vue'
import { CAMPAIGNS } from '../../../lib/campaigns'
import type { RepeatSpec } from '../../../lib/metrics/types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
function mountRepeat(modelValue: RepeatSpec | undefined, allow: RepeatSpec['over'][] = ['campaigns', 'popups', 'assets']) {
  const w = mount(CardEditorRepeat, {
    props: { modelValue, allow, 'onUpdate:modelValue': (v: RepeatSpec | undefined) => void w.setProps({ modelValue: v }) },
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
const last = (w: VueWrapper) => {
  const ev = w.emitted('update:modelValue')
  expect(ev).toBeTruthy()
  return ev![ev!.length - 1][0] as RepeatSpec | undefined
}
const labelled = (w: VueWrapper, text: string) => w.findAll('label').find((l) => l.text().startsWith(text))!

describe('the repeat editor and the assets axis', () => {
  it('offers "One per ad asset" next to the campaign axis, and picking it saves { over: assets }', async () => {
    const w = mountRepeat(undefined)
    const options = w.findAll('select option').map((o) => o.text())
    expect(options).toContain('One per campaign')
    expect(options).toContain('One per ad asset (headline, description, image)')
    await w.find('select').setValue('assets')
    expect(last(w)).toEqual({ over: 'assets' })
  })
  it('does not offer the axis where the host does not allow it', () => {
    const w = mountRepeat(undefined, ['campaigns', 'popups'])
    expect(w.findAll('select option').map((o) => o.text())).not.toContain('One per ad asset (headline, description, image)')
  })
  it('campaign, order by and show-at-most are saved; blank settings are dropped; the order list is the three asset totals', async () => {
    const w = mountRepeat({ over: 'assets' })
    const selects = w.findAll('select')
    const sort = selects.find((s) => s.findAll('option').some((o) => o.text() === 'Clicks'))!
    expect(sort.findAll('option').map((o) => o.text())).toEqual(['Impressions (default)', 'Impressions', 'Clicks', 'Conversions'])
    await sort.setValue('clicks')
    expect(last(w)).toEqual({ over: 'assets', sortBy: 'clicks' })
    const limit = w.find('input[type="number"]')
    await limit.setValue('5')
    expect(last(w)).toEqual({ over: 'assets', sortBy: 'clicks', limit: 5 })
    const camp = selects.find((s) => s.findAll('option').some((o) => o.text() === 'From the enclosing campaign repeat'))!
    await camp.setValue(CAMPAIGNS[0].id)
    expect(last(w)).toEqual({ over: 'assets', sortBy: 'clicks', limit: 5, campaignId: CAMPAIGNS[0].id })
    await camp.setValue('')
    await sort.setValue('')
    await limit.setValue('')
    expect(last(w)).toEqual({ over: 'assets' })
    expect(labelled(w, 'Order by').text()).toContain('highest first')
  })
  it('the card editor offers it at the card level and in a section (a section repeat under a campaign repeat)', () => {
    const spec = { v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [] }] }
    const w = mount(CardEditor, { props: { modelValue: { spec } as never }, attachTo: document.body })
    mounted.push(w)
    const offers = w.findAll('select option').filter((o) => o.text().startsWith('One per ad asset'))
    expect(offers.length).toBeGreaterThanOrEqual(2)
  })
  it('the asset param has no picker (it fell through to the country options): outside an assets repeat a hint, inside none', () => {
    const outside = mount(CardEditorData, { props: { modelValue: { metric: 'asset.clicks' } as never }, attachTo: document.body })
    mounted.push(outside)
    expect(outside.findAll('label').some((l) => l.text().startsWith('Asset'))).toBe(false)
    expect(outside.findAll('option').some((o) => ['US', 'CA', 'Other'].includes(o.text()))).toBe(false)
    expect(outside.text()).toContain('One per ad asset')
    const inside = mount(CardEditorData, { props: { modelValue: { metric: 'asset.clicks' } as never, repeatOver: 'assets' }, attachTo: document.body })
    mounted.push(inside)
    expect(inside.findAll('label').some((l) => l.text().startsWith('Asset'))).toBe(false)
    expect(inside.findAll('option').some((o) => ['US', 'CA', 'Other'].includes(o.text()))).toBe(false)
    expect(inside.text()).not.toContain('Asset metrics read one ad asset')
  })
})
