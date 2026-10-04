// Automatic scope caveats (1c, D2-B) honour a registry entry's activeWhen gate. Both tracking dates
// are set in lib/popupEvents.ts today, so the gated entries are off; this file turns them back on.
import { describe, expect, it, vi } from 'vitest'
import { allChartNotes } from './chartNotes'
import { LAYOUT_VERSIONS, defaultConfig, normalizeConfig } from './defaults'
import type { DashboardConfig, Widget } from '../types'

vi.mock('./popupEvents', async (orig) => ({
  ...(await orig<typeof import('./popupEvents')>()),
  TRACKING_ACTIVATION_DATE_ET: null,
  PLAY_TRACKING_ACTIVATION_DATE_ET: null,
}))

const chart = (dataset: string): Widget => ({ id: 'w', i: 'w', title: 'T', type: 'table', dataset, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }) as Widget

describe('automatic caveats with their activeWhen gate on', () => {
  it('a gated caveat shows while its gate is on', () => {
    expect(allChartNotes(chart('campaigns'), null, null).map((n) => n.key)).toContain('caveat:play-tracking-not-live')
    expect(allChartNotes(chart('popup'), null, null).map((n) => n.key)).toContain('caveat:tracking-not-yet-active')
  })

  it('the v16 step hides an active gated caveat a pre-v16 chart did not show', () => {
    const base = defaultConfig()
    const cfg: DashboardConfig = { ...base, version: LAYOUT_VERSIONS.captions - 1, pages: [{ ...base.pages[0], widgets: [chart('popup')] }] }
    expect(normalizeConfig(cfg).pages[0].widgets[0].hiddenCaveats).toContain('tracking-not-yet-active')
  })
})
