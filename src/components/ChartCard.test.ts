// @vitest-environment happy-dom
//
// Component tests for the clean-look fix (fix/clean-look, 2026-09-26, revised per owner
// clarification): every chart shows exactly two small, low-contrast icons ALWAYS visible in
// its corner on every device including touch — zoom (one tap/click) and reveal (a per-card
// disclosure toggle). Everything else — filter/reload/options-menu, and the drag-handle/
// resize-grip affordances in Dashboard.vue's CSS — stays hidden until: this card's own reveal
// is on, the page's edit mode is on (`forceControls`/`.controls-revealed`), or (desktop only)
// the card is hovered/focused-within. A note widget shows only the reveal icon (nothing to
// zoom). These assert on the STRUCTURAL wiring (props/state -> classes/attributes/rendered
// elements) that the CSS keys off of — the actual pixel-level hover/opacity behavior is
// verified separately against a real browser (see review-shots/ and the PR description), since
// happy-dom doesn't evaluate `@media (hover: hover)` reliably.
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
  scorecard: [],
  releasePanel: null,
}
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const statsFor = () => ({ rows: [{ key: { date: '2026-09-26' }, pageviews: 5, visits: 5 }], totals: { pageviews: 5, visits: 5 }, meta: { site: 'all', host: null, since: '2026-09-26', until: '2026-09-27', dimensions: ['date'], metric: 'pageviews' } })
  return {
    ...actual,
    fetchOverview: vi.fn(async () => MINIMAL_OVERVIEW_RESPONSE),
    fetchSeriesStats: vi.fn(async (w: Widget) => (w.series ?? []).map(statsFor)),
  }
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
  // No Teleport stub: @vue/test-utils' built-in stub doesn't preserve DOM node identity
  // across re-renders in this Vue version (verified directly — a stubbed mount's own button
  // wrapper kept reporting stale attributes after a state-changing click, even though a FRESH
  // `.get()` call on the same selector saw the update; unstubbed, the same wrapper updates
  // live, as normal Vue DOM patching does). The real Teleport with `:disabled="!zoomed"`
  // (zoomed stays false in every test here) renders in place regardless.
  return mount(ChartCard, {
    props: { widget, filters, dark: false, drillOpen: false, forceControls },
  })
}

describe('ChartCard — zoom + reveal are visible by default, on every device', () => {
  // happy-dom doesn't evaluate `@media (pointer: coarse)`, so "on touch" here means: neither
  // button carries the hide-until-edit-mode class that the touch-hiding bug (round 1 of this
  // fix) relied on — i.e. the same markup renders for touch and desktop; the CSS that
  // differentiates them is pixel-verified separately (see file header).
  it('the zoom button exists and is never wrapped in .hide-until-revealed', () => {
    const w = mountCard(baseWidget())
    const zoomBtn = w.get('.zoom-btn')
    expect(zoomBtn.classes()).not.toContain('hide-until-revealed')
    expect(zoomBtn.element.closest('.hide-until-revealed')).toBeNull()
  })

  it('the reveal button exists and is never wrapped in .hide-until-revealed', () => {
    const w = mountCard(baseWidget())
    const revealBtn = w.get('.reveal-btn')
    expect(revealBtn.classes()).not.toContain('hide-until-revealed')
    expect(revealBtn.element.closest('.hide-until-revealed')).toBeNull()
  })

  it('the filter/reload/options-menu group IS hidden by default (only these three)', () => {
    const w = mountCard(baseWidget())
    const group = w.get('.revealed-controls')
    expect(group.classes()).toContain('hide-until-revealed')
    expect(group.find('.menu-anchor').exists()).toBe(true)
  })
})

describe('ChartCard — reveal toggles THIS chart only', () => {
  it('starts closed: aria-expanded="false", no .revealed class', () => {
    const w = mountCard(baseWidget())
    expect(w.get('.reveal-btn').attributes('aria-expanded')).toBe('false')
    expect(w.get('.chart-card').classes()).not.toContain('revealed')
  })

  it('a click opens it: aria-expanded="true", .revealed class added, aria-controls points at the revealed group', async () => {
    const w = mountCard(baseWidget())
    const reveal = w.get('.reveal-btn')
    const controlsId = reveal.attributes('aria-controls')
    expect(controlsId).toBeTruthy()
    expect(w.get('.revealed-controls').attributes('id')).toBe(controlsId)
    await reveal.trigger('click')
    expect(reveal.attributes('aria-expanded')).toBe('true')
    expect(w.get('.chart-card').classes()).toContain('revealed')
  })

  it('a second click closes it again', async () => {
    const w = mountCard(baseWidget())
    const reveal = w.get('.reveal-btn')
    await reveal.trigger('click')
    expect(reveal.attributes('aria-expanded')).toBe('true')
    await reveal.trigger('click')
    expect(reveal.attributes('aria-expanded')).toBe('false')
    expect(w.get('.chart-card').classes()).not.toContain('revealed')
  })

  it('Escape closes it', async () => {
    const w = mountCard(baseWidget())
    await w.get('.reveal-btn').trigger('click')
    expect(w.get('.chart-card').classes()).toContain('revealed')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()
    expect(w.get('.chart-card').classes()).not.toContain('revealed')
  })

  it('a click outside the card closes it', async () => {
    const w = mountCard(baseWidget())
    await w.get('.reveal-btn').trigger('click')
    expect(w.get('.chart-card').classes()).toContain('revealed')
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.get('.chart-card').classes()).not.toContain('revealed')
  })

  it('opening one card\'s reveal does not affect a second, independently-mounted card', async () => {
    const a = mountCard(baseWidget({ id: 'a', i: 'a' }))
    const b = mountCard(baseWidget({ id: 'b', i: 'b' }))
    await a.get('.reveal-btn').trigger('click')
    expect(a.get('.chart-card').classes()).toContain('revealed')
    expect(b.get('.chart-card').classes()).not.toContain('revealed')
    expect(b.get('.reveal-btn').attributes('aria-expanded')).toBe('false')
  })
})

describe('ChartCard — page edit mode reveals every chart', () => {
  it('is not in edit mode by default: no .controls-revealed class', () => {
    const w = mountCard(baseWidget())
    expect(w.get('.chart-card').classes()).not.toContain('controls-revealed')
  })

  it('forceControls adds .controls-revealed, which the CSS uses to reveal the filter/reload/menu group on every device — without needing this card\'s own reveal toggled on', () => {
    const w = mountCard(baseWidget(), true)
    expect(w.get('.chart-card').classes()).toContain('controls-revealed')
    expect(w.get('.chart-card').classes()).not.toContain('revealed') // page edit mode, not this card's own toggle
  })

  it('applies independently to every mounted card (each gets forceControls as a prop)', () => {
    const a = mountCard(baseWidget({ id: 'a', i: 'a' }), true)
    const b = mountCard(baseWidget({ id: 'b', i: 'b' }), true)
    expect(a.get('.chart-card').classes()).toContain('controls-revealed')
    expect(b.get('.chart-card').classes()).toContain('controls-revealed')
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

  it('has no zoom control (nothing to zoom) but does have the reveal icon', () => {
    const w = mountCard(baseWidget({ type: 'note', title: 'Small sample', noteId: 'small-sample' } as Partial<Widget>))
    expect(w.find('.zoom-btn').exists()).toBe(false)
    expect(w.find('.reveal-btn').exists()).toBe(true)
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
  // generic path should remain — one NoteBlock, not two. (The timeline is the standard line
  // chart since CONFIG_VERSION 9; its caption still comes only from widget.notes.)
  it('renders the registry caption once, not twice', async () => {
    const w = mountCard(
      baseWidget({
        id: 'ow-timeline',
        i: 'ow-timeline',
        title: 'Overall timeline',
        type: 'line',
        dataset: 'geo',
        dimension: 'date',
        metric: 'pageviews',
        limit: 400,
        series: [{ label: 'Page views' }, { label: 'Installs', filter: [{ field: 'keyEvent', value: 'install' }], axis: 'right' }],
        notes: ['overview-timeline-caption'],
      } as Partial<Widget>),
    )
    await flushPromises()
    await flushPromises() // the composable's own .then() hop needs a second microtask flush
    const captions = w.findAll('.note-block').filter((n) => n.text().includes('Shaded bands = campaign flights'))
    expect(captions).toHaveLength(1)
  })
})
