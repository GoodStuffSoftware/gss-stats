// @vitest-environment happy-dom
//
// A card's own captions in CardEditor (slice 1c, decision D7, review N1). Show/Hide edits only the
// widget's hidden list (`update:hiddenCaptions`), never `spec.captions`; a caption that affects what
// the data means cannot be hidden; an id the registry does not know is listed and can be removed,
// the one case where the editor changes `spec.captions`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { validateCard } from '../../lib/metrics/validate'
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
  vi.stubGlobal('confirm', () => true)
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
async function mountEditor(modelValue: CardRef, hiddenCaptions?: string[]) {
  const w = mount(CardEditor, { props: { modelValue, ...(hiddenCaptions ? { hiddenCaptions } : {}) }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
const rows = (w: VueWrapper) => w.findAll('.ce-caption-row')
const toggle = (w: VueWrapper, i = 0) => rows(w)[i].find('button.ce-caption-toggle')
const hiddenEmits = (w: VueWrapper) => (w.emitted('update:hiddenCaptions') ?? []).map((e) => e[0] as string[])
/** The spec the editor holds: its last emit, or the input when nothing was emitted. */
function heldSpec(w: VueWrapper, input: CardSpec): CardSpec {
  const ev = w.emitted('update:modelValue')
  return ev?.length ? (ev[ev.length - 1][0] as { spec: CardSpec }).spec : input
}
/** release-before-after (caption `release-before-partial`, hideable), customized. */
function releaseSpec(extra: string[] = []): CardSpec {
  const spec = plain(PRESETS['release-before-after'])
  expect(spec.captions).toEqual(['release-before-partial'])
  if (extra.length) spec.captions = [...spec.captions!, ...extra]
  return spec
}

describe('Show/Hide toggles for the spec captions', () => {
  it('a preset card (before Customize) lists its caption; Hide then Show emit the hidden list and never touch the spec', async () => {
    const w = await mountEditor({ preset: 'release-before-after' })
    expect(rows(w)).toHaveLength(1)
    expect(rows(w)[0].text()).toContain('Hide')
    expect(toggle(w).attributes('disabled')).toBeUndefined()
    expect(toggle(w).attributes('aria-pressed')).toBe('false')

    await toggle(w).trigger('click')
    await flushPromises()
    expect(hiddenEmits(w)).toEqual([['release-before-partial']])
    expect(toggle(w).text()).toBe('Show')
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
    expect(rows(w)[0].text()).toContain('hidden on this card')
    // The live preview gets the same hidden list.
    expect(w.findComponent(MetricCard).props('hiddenCaptions')).toEqual(['release-before-partial'])

    await toggle(w).trigger('click')
    await flushPromises()
    expect(hiddenEmits(w)).toEqual([['release-before-partial'], []])
    expect(toggle(w).text()).toBe('Hide')
    // A preset card still emits only { preset }: the captions stay the preset's.
    for (const [ref] of w.emitted('update:modelValue') ?? []) expect(ref).toStrictEqual({ preset: 'release-before-after' })
  })

  it('a customized card: Hide and Show leave spec.captions exactly as stored', async () => {
    const spec = releaseSpec()
    const w = await mountEditor({ spec: plain(spec), from: 'release-before-after' })
    await toggle(w).trigger('click')
    await flushPromises()
    expect(heldSpec(w, spec).captions).toEqual(['release-before-partial'])
    await toggle(w).trigger('click')
    await flushPromises()
    expect(hiddenEmits(w)).toEqual([['release-before-partial'], []])
    expect(heldSpec(w, spec)).toStrictEqual(spec)
  })

  it('keeps the other hidden ids in the list, and follows the prop when the host writes it back', async () => {
    const w = await mountEditor({ spec: releaseSpec(), from: 'release-before-after' }, ['popup-note'])
    expect(toggle(w).text()).toBe('Hide')
    await toggle(w).trigger('click')
    await flushPromises()
    expect(hiddenEmits(w).at(-1)).toEqual(['popup-note', 'release-before-partial'])
    await w.setProps({ hiddenCaptions: ['popup-note', 'release-before-partial'] })
    expect(toggle(w).text()).toBe('Show')
    await toggle(w).trigger('click')
    await flushPromises()
    expect(hiddenEmits(w).at(-1)).toEqual(['popup-note'])
    // The host clears the list from outside: the toggle follows.
    await w.setProps({ hiddenCaptions: ['release-before-partial'] })
    expect(toggle(w).text()).toBe('Show')
    await w.setProps({ hiddenCaptions: undefined })
    expect(toggle(w).text()).toBe('Hide')
  })

  it('a caption that affects what the data means is shown with a disabled toggle and the reason', async () => {
    const w = await mountEditor({ preset: 'campaign-country' }, ['country-split-excludes-refused'])
    expect(rows(w)).toHaveLength(1)
    const t = toggle(w)
    expect(t.attributes('disabled')).toBeDefined()
    expect(t.text()).toBe('Hide') // listed in the hidden list, but it cannot be hidden: still shown
    expect(rows(w)[0].text()).toContain('always shown: affects what the data means')
    await t.trigger('click')
    ;(t.element as HTMLButtonElement).click()
    await flushPromises()
    expect(hiddenEmits(w)).toEqual([])
  })

  it('points to the chart caption for new text, with or without spec captions', async () => {
    const withCaption = await mountEditor({ preset: 'release-before-after' })
    expect(withCaption.find('.ce-captions').text()).toContain("Add your own text in the chart's Caption field")
    const without = await mountEditor({ preset: 'bsk-kpis' })
    expect(without.findAll('.ce-caption-row')).toHaveLength(0)
    expect(without.find('.ce-captions').text()).toContain('This card has no captions of its own.')
    expect(without.find('.ce-captions').text()).toContain("Add your own text in the chart's Caption field")
  })
})

describe('unknown caption ids (N1)', () => {
  it('lists an unknown id, keeps it unchanged, and Remove drops only that id', async () => {
    const spec = releaseSpec(['gone-note'])
    // Valid as stored (slice 1a keeps a newer build's ids), so it saves unchanged until removed.
    expect(validateCard(spec)).toEqual([])
    const w = await mountEditor({ spec: plain(spec), from: 'release-before-after' })
    expect(rows(w)).toHaveLength(2)
    expect(rows(w)[1].text()).toContain('Unknown note gone-note')
    expect(rows(w)[1].find('button.ce-caption-toggle').exists()).toBe(false)
    // Untouched, the unknown id stays exactly where it was.
    await toggle(w).trigger('click')
    await flushPromises()
    expect(heldSpec(w, spec)).toStrictEqual(spec)

    await rows(w)[1].findAll('button').find((b) => b.text() === 'Remove')!.trigger('click')
    await flushPromises()
    const out = heldSpec(w, spec)
    expect(out.captions).toEqual(['release-before-partial'])
    expect(validateCard(out)).toEqual([])
    expect(out).toStrictEqual({ ...spec, captions: ['release-before-partial'] })
    expect(rows(w)).toHaveLength(1)
  })

  it('removing the only caption deletes the key', async () => {
    const spec = plain(PRESETS['bsk-kpis'])
    spec.captions = ['gone-note']
    const w = await mountEditor({ spec: plain(spec), from: 'bsk-kpis' })
    await rows(w)[0].findAll('button').find((b) => b.text() === 'Remove')!.trigger('click')
    await flushPromises()
    const out = heldSpec(w, spec)
    expect('captions' in out).toBe(false)
    expect(validateCard(out)).toEqual([])
  })
})
