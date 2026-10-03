// @vitest-environment happy-dom
//
// The card editor and the load limits (next-phases plan, Phase 2 + slice 1a): the badge colour
// list stops at the load limit, a card over a limit shows why and is never emitted, and the
// captions picker keeps an id it doesn't offer (a newer build's). MetricCard shows only the
// captions this build knows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { CARD_LIMITS, normCardRef } from '../../lib/metrics/validate'
import { PRESETS } from '../../lib/metrics/presets'
import type { CardRef, CardSpec } from '../../lib/metrics/types'

const mounted: VueWrapper[] = []
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 1 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function mountEditor(modelValue: CardRef) {
  const w = mount(CardEditor, { props: { modelValue }, attachTo: document.body })
  mounted.push(w)
  return w
}
function lastSpec(w: VueWrapper): CardSpec {
  const ev = w.emitted('update:modelValue')
  expect(ev).toBeTruthy()
  return (ev![ev!.length - 1][0] as { spec: CardSpec }).spec
}
const controls = (w: VueWrapper) => w.find('.ce-controls')
const addColour = (w: VueWrapper) => controls(w).findAll('button').find((b) => b.text() === '+ Add a colour')!
const errorsText = (w: VueWrapper) => controls(w).findAll('.errors li').map((e) => e.text())
const tones = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`status ${i}`, 'live' as const]))
function scorecardWithTones(n: number): CardSpec {
  const s = plain(PRESETS['campaign-scorecard'])
  ;(s.badge!.display as { tones?: Record<string, string> }).tones = tones(n)
  return s
}

describe('badge colours stop at the load limit', () => {
  it('adding stops at 32: the button turns off and says why, and the 32-colour card saves and loads', async () => {
    const w = mountEditor({ preset: 'campaign-scorecard' })
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Customize…')!.trigger('click')
    await flushPromises()
    const start = Object.keys(lastSpec(w).badge!.display.tones ?? {}).length
    for (let i = start; i < 32; i++) await addColour(w).trigger('click')
    await flushPromises()
    expect(Object.keys(lastSpec(w).badge!.display.tones ?? {})).toHaveLength(32)
    const btn = addColour(w)
    expect(btn.attributes('disabled')).toBeDefined()
    const hintId = btn.attributes('aria-describedby')!
    expect(controls(w).find(`#${CSS.escape(hintId)}`).text()).toBe('Up to 32 colours')
    // A click that gets through anyway adds nothing.
    const emits = w.emitted('update:modelValue')!.length
    btn.element.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(w.emitted('update:modelValue')!.length).toBe(emits)
    expect(errorsText(w)).toEqual([])
    const saved = lastSpec(w)
    expect(normCardRef(JSON.parse(JSON.stringify({ spec: saved })))).toEqual({ spec: saved })
  }, 60_000)

  it('a card already over the limit (33 colours) shows the error and is never emitted', async () => {
    const w = mountEditor({ spec: scorecardWithTones(33) })
    await flushPromises()
    expect(errorsText(w)).toContain(`Badge colours: up to ${CARD_LIMITS.objectKeys} (this card has 33)`)
    const errs = w.emitted('errors')!
    expect((errs[errs.length - 1][0] as string[]).length).toBeGreaterThan(0)
    expect(w.emitted('update:modelValue')).toBeUndefined()
    expect(addColour(w).attributes('disabled')).toBeDefined()
  })
})

describe('captions the picker does not offer are kept', () => {
  it('ticking an offered caption keeps a newer build\'s id', async () => {
    const spec = plain(PRESETS['campaign-scorecard'])
    spec.captions = ['future-caveat-v99']
    const w = mountEditor({ spec })
    await flushPromises()
    const labelId = controls(w).findAll('label').find((l) => l.text().startsWith('Captions'))!.attributes('id')!
    const box = controls(w).find(`[aria-labelledby="${labelId}"]`).find('input[type=checkbox]')
    await box.setValue(true)
    await flushPromises()
    const captions = lastSpec(w).captions!
    expect(captions).toContain('future-caveat-v99')
    expect(captions).toHaveLength(2)
    await box.setValue(false)
    await flushPromises()
    expect(lastSpec(w).captions).toEqual(['future-caveat-v99'])
  })
})

describe('MetricCard shows only the captions this build knows', () => {
  const withCaptions = (captions: string[]): CardRef => ({ spec: { ...plain(PRESETS['bsk-kpis']), captions } })
  it('an unknown id is skipped; a card whose captions are all unknown has no captions block', async () => {
    const known = mount(MetricCard, { props: { cardRef: withCaptions(['arrivals-caveat', 'future-caveat-v99']), nowMs: Date.parse('2026-09-27T12:00:00Z') } })
    mounted.push(known)
    await flushPromises()
    expect(known.findAll('.mc-captions > *')).toHaveLength(1)
    expect(known.text()).not.toContain('future-caveat-v99')
    const none = mount(MetricCard, { props: { cardRef: withCaptions(['future-caveat-v99']), nowMs: Date.parse('2026-09-27T12:00:00Z') } })
    mounted.push(none)
    await flushPromises()
    expect(none.find('.mc-captions').exists()).toBe(false)
    expect(none.text()).not.toContain('future-caveat-v99')
  })
})
