// @vitest-environment happy-dom
//
// Component tests for the clean-look fix (fix/clean-look, 2026-09-26): the header bar's
// modification chrome must be hidden by default (including on touch, where the previous CSS
// only hid it on hover-capable devices — see ChartCard.vue's .hide-until-revealed comment) and
// revealed only via edit mode (`forceControls`/`.controls-revealed`); a note widget must render
// as a bare compact caption with no title row and no zoom control at all. These assert on the
// STRUCTURAL wiring (props -> classes/rendered elements) that the CSS keys off of — the actual
// pixel-level hover/opacity behavior is verified separately against a real browser (see
// review-shots/ and the PR description), since happy-dom doesn't evaluate
// `@media (hover: hover)` reliably.
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import type { Widget, GlobalFilters, OverviewResponse } from '../types'

// Only fetchOverview is overridden (a minimal, synchronous-ish fixture) — everything else in
// '../api' stays real, so this doesn't have to track every export it has.
const MINIMAL_OVERVIEW_RESPONSE: OverviewResponse = {
  generatedAt: '2026-09-26T12:00:00Z',
  todayEt: '2026-09-26',
  kpis: [],
  timeline: {
    daily: [{ date: '2026-09-26', pageviews: 5, taggedArrivals: 0, authSuccess: 0, install: 0 }],
    campaignFlights: [],
    releaseMarkers: [],
    trackingActivationDate: null,
    since: '2026-09-01',
    until: '2026-09-26',
  },
  scorecard: [],
  releasePanel: null,
}
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchOverview: vi.fn(async () => MINIMAL_OVERVIEW_RESPONSE) }
})

const filters: GlobalFilters = {
  siteSel: [],
  since: '2026-09-01',
  until: '2026-09-26',
  excludeSelfReferrals: false,
  excludeOwnVisits: false,
  ownBrowser: '',
  ownOS: '',
}

function baseWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: 'w1',
    i: 'w1',
    title: 'Pageviews by site',
    type: 'stat',
    dimension: '',
    metric: 'pageviews',
    limit: 1,
    x: 0,
    y: 0,
    w: 3,
    h: 3,
    ...overrides,
  }
}

function mountCard(widget: Widget, forceControls = false) {
  return mount(ChartCard, {
    props: { widget, filters, dark: false, drillOpen: false, forceControls },
    global: { stubs: { Teleport: true } },
  })
}

describe('ChartCard — modification chrome hidden until edit mode', () => {
  it('is not in edit mode by default: no .controls-revealed class', () => {
    const w = mountCard(baseWidget())
    expect(w.get('.chart-card').classes()).not.toContain('controls-revealed')
  })

  it('edit mode (forceControls) adds .controls-revealed, which the CSS uses to reveal chrome on every device including touch', () => {
    const w = mountCard(baseWidget(), true)
    expect(w.get('.chart-card').classes()).toContain('controls-revealed')
  })

  it('the options menu button carries .hide-until-revealed (hidden-by-default base rule, not gated on a hover media query)', () => {
    const w = mountCard(baseWidget())
    const menuBtn = w.get('.menu-anchor')
    expect(menuBtn.classes()).toContain('hide-until-revealed')
  })

  it('the zoom button exists for a normal chart widget and is a plain floating icon, not inside a header bar row', () => {
    const w = mountCard(baseWidget())
    expect(w.find('.zoom-btn').exists()).toBe(true)
  })
})

describe('ChartCard — note widgets render as a bare compact caption', () => {
  it('gets the .note-card modifier (no border/background/title row per CSS)', () => {
    const w = mountCard(baseWidget({ type: 'note', title: 'Small sample', noteId: 'small-sample' } as Partial<Widget>))
    expect(w.get('.chart-card').classes()).toContain('note-card')
  })

  it('renders no title row at all (old bespoke pages showed the note text alone, no heading)', () => {
    const w = mountCard(baseWidget({ type: 'note', title: 'Small sample', noteId: 'small-sample' } as Partial<Widget>))
    expect(w.find('.title-wrap').exists()).toBe(false)
  })

  it('has no zoom control (nothing to zoom)', () => {
    const w = mountCard(baseWidget({ type: 'note', title: 'Small sample', noteId: 'small-sample' } as Partial<Widget>))
    expect(w.find('.zoom-btn').exists()).toBe(false)
  })

  it('its header carries .note-head, the absolute-overlay variant (never reserves layout space)', () => {
    const w = mountCard(baseWidget({ type: 'note', title: 'Small sample', noteId: 'small-sample' } as Partial<Widget>))
    expect(w.get('.card-head').classes()).toContain('note-head')
  })
})

describe('ChartCard — a normal (non-note) widget still shows its title', () => {
  it('renders the title text', () => {
    const w = mountCard(baseWidget({ title: 'Pageviews by site' }))
    expect(w.get('.title').text()).toBe('Pageviews by site')
  })
})

describe('ChartCard — the overview timeline caption renders exactly once (coordinator-flagged regression, 2026-09-26)', () => {
  // The "Shaded bands = campaign flights…" caption used to render TWICE: once hard-coded
  // inline in OverviewWidgetBody.vue's timeline template, and once more through ChartCard's
  // generic attached-caption system (widget.notes -> widgetCaptionNoteIds -> the SAME
  // registry note, 'overview-timeline-caption', via the SAME NoteBlock component). Only the
  // generic path should remain — one NoteBlock, not two.
  it('renders the registry caption once, not twice', async () => {
    const w = mountCard(
      baseWidget({
        id: 'ow-timeline',
        i: 'ow-timeline',
        title: 'Overall timeline',
        type: 'table',
        dataset: 'overview',
        view: 'timeline',
        dimension: '',
        metric: 'pageviews',
        limit: 1,
        notes: ['overview-timeline-caption'],
      } as Partial<Widget>),
    )
    await flushPromises()
    await flushPromises() // the composable's own .then() hop needs a second microtask flush
    const captions = w.findAll('.note-block').filter((n) => n.text().includes('Shaded bands = campaign flights'))
    expect(captions).toHaveLength(1)
  })
})
