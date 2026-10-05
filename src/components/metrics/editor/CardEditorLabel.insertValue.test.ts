// @vitest-environment happy-dom
//
// A card label's "+ Insert variable…" and the chart caption's "Insert value" are ONE control and
// one vocabulary (notes plan slice 1d, release 2): the repeat's own fields insert `{campaign.label}`
// exactly as before, and the fixed dates insert `{=…}` tokens that a card label then fills in.
// Insertion is the explicit Insert button (review N3), never the select's change.
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CardEditorLabel from './CardEditorLabel.vue'
import { provideEditorContext } from './editorContext'
import { __resetMetricsStateForTests, useMetrics } from '../../../composables/useMetrics'
import { todayEtFrom } from '../../../lib/metrics/scope'
import type { MetricsContext } from '../../../lib/metrics/types'

const mounted: VueWrapper[] = []
beforeEach(() => __resetMetricsStateForTests())
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.unstubAllGlobals()
  __resetMetricsStateForTests()
})
function open(modelValue: string, repeatOver?: 'campaigns' | 'popups') {
  const w = mount(CardEditorLabel, { props: { modelValue, hasData: true, ...(repeatOver ? { repeatOver } : {}) }, attachTo: document.body })
  mounted.push(w)
  return w
}
const menu = (w: VueWrapper) => w.get('select.insert-value')
const btn = (w: VueWrapper) => menu(w).element.parentElement!.querySelector('button.insert-picker-btn') as HTMLButtonElement
const lastModel = (w: VueWrapper) => w.emitted('update:modelValue')?.at(-1)?.[0]

describe('CardEditorLabel: Insert value', () => {
  it('offers the repeat\'s own fields and the dates in one menu, as the caption does', () => {
    const w = open('Hello', 'campaigns')
    expect(menu(w).attributes('aria-label')).toMatch(/^Insert a value into the/)
    expect(menu(w).findAll('option')[0].text()).toBe('Insert value ▾')
    expect(menu(w).findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Fields', 'Dates', 'Metrics'])
    const values = menu(w).findAll('option').map((o) => o.attributes('value'))
    expect(values).toContain('{campaign.label}')
    expect(values).toContain('{=golive.web|date}')
    expect(values.some((v) => v?.startsWith('{=chart.'))).toBe(false) // a card label has no chart
  })

  it('a field still inserts {path}, and only on the Insert button', async () => {
    const w = open('Tagged arrivals — ', 'campaigns')
    await menu(w).setValue('{campaign.label}')
    expect(lastModel(w)).toBeUndefined() // choosing is not inserting (N3)
    await btn(w).click()
    expect(lastModel(w)).toBe('Tagged arrivals — {campaign.label}')
  })

  it('a date inserts its token', async () => {
    const w = open('Since ', 'campaigns')
    await menu(w).setValue('{=golive.web|date}')
    await btn(w).click()
    expect(lastModel(w)).toBe('Since {=golive.web|date}')
  })

  // The model is written back so the input shows each insert, as the card editor's v-model does.
  function openLive(modelValue: string, repeatOver?: 'campaigns' | 'popups') {
    const w: VueWrapper = mount(CardEditorLabel, {
      props: { modelValue, hasData: true, ...(repeatOver ? { repeatOver } : {}), 'onUpdate:modelValue': (v: unknown) => w.setProps({ modelValue: v as string }) },
      attachTo: document.body,
    })
    mounted.push(w)
    return w
  }
  const textBox = (w: VueWrapper) => w.get('input[type="text"]:not(.search-input)').element as HTMLInputElement

  it('after Insert, focus goes back to the label box with the caret at the end', async () => {
    const w = openLive('Since ', 'campaigns')
    await menu(w).setValue('{=golive.web|date}')
    btn(w).focus()
    await btn(w).click()
    await flushPromises()
    const box = textBox(w)
    expect(box.value).toBe('Since {=golive.web|date}')
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([box.value.length, box.value.length])
  })

  it('a token that would take the label past 200 characters is refused whole, says so, and still returns focus', async () => {
    const full = 'y'.repeat(190)
    const w = openLive(full)
    await menu(w).setValue('{=golive.web|date}') // 18 characters: 208 in all
    btn(w).focus()
    await btn(w).click()
    await flushPromises()
    expect(lastModel(w)).toBeUndefined() // nothing written
    expect(textBox(w).value).toBe(full)
    expect(w.get('.label-full').text()).toBe('Label is full')
    expect(document.activeElement).toBe(textBox(w))
    // typing clears the notice, and a token that fits goes in whole
    await w.get('input[type="text"]:not(.search-input)').setValue(full.slice(0, 170))
    expect(w.get('.label-full').text()).toBe('')
    await menu(w).setValue('{=golive.web|date}')
    await btn(w).click()
    expect(lastModel(w)).toBe(`${full.slice(0, 170)}{=golive.web|date}`)
  })

  it('with no repeat there are no fields, only the dates and the metrics', () => {
    const w = open('Hello')
    expect(menu(w).findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Dates', 'Metrics'])
  })

  // ── Metrics group (value-tokens release 3) ──
  const METRIC_TOKEN = '{=metric:bsk.pageviews@page|number}'
  const metricValues = (w: VueWrapper) => menu(w).findAll('optgroup[label="Metrics"] option').map((o) => o.attributes('value'))

  it('offers the Metrics group: the page and today-so-far windows of the catalog, as the caption does', () => {
    const w = open('Hello', 'campaigns')
    const values = metricValues(w)
    expect(values).toContain(METRIC_TOKEN)
    expect(values).toContain('{=metric:bsk.pageviews@todaySoFar|number}')
    expect(values.every((v) => v?.startsWith('{=metric:'))).toBe(true)
  })

  it('a metric inserts its token on the Insert button, whole', async () => {
    const w = open('Views: ', 'campaigns')
    await menu(w).setValue(METRIC_TOKEN)
    await btn(w).click()
    expect(lastModel(w)).toBe(`Views: ${METRIC_TOKEN}`)
  })

  it('a metric option shows what the page already holds for the editor context, and its name alone otherwise', async () => {
    const ctx: MetricsContext = { since: '2026-09-01T04:00:00.000Z', until: '2026-10-01T04:00:00.000Z' }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
        return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: { [body.requests[0].key]: { status: 'ok', value: 4321 } }, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
      }),
    )
    const holder = effectScope()
    holder.run(() => useMetrics(ctx, () => todayEtFrom(Date.now())).request({ metric: 'bsk.pageviews', window: 'page' }))
    await new Promise((r) => setTimeout(r, 40))
    await flushPromises()
    const withContext = mount({ components: { CardEditorLabel }, setup: () => (provideEditorContext(() => ctx), {}), template: '<CardEditorLabel model-value="x" :has-data="true" />' }, { attachTo: document.body })
    mounted.push(withContext)
    const optionText = (w: VueWrapper) => menu(w).find(`option[value="${METRIC_TOKEN}"]`).text()
    expect(optionText(withContext)).toMatch(/\(4,321\)$/)
    const without = open('x') // no context provided: names only
    expect(optionText(without)).toBe('Page views (page range)')
    holder.stop()
  })

  it('after a metric Insert, focus goes back to the label box with the caret at the end', async () => {
    const w = openLive('Views ', 'campaigns')
    await menu(w).setValue(METRIC_TOKEN)
    btn(w).focus()
    await btn(w).click()
    await flushPromises()
    const box = textBox(w)
    expect(box.value).toBe(`Views ${METRIC_TOKEN}`)
    expect(document.activeElement).toBe(box)
    expect([box.selectionStart, box.selectionEnd]).toEqual([box.value.length, box.value.length])
  })

  it('a metric token that would take the label past 200 characters is not inserted: "Label is full", focus kept', async () => {
    const full = 'y'.repeat(190) // the token is longer than the 10 characters left
    const w = openLive(full)
    await menu(w).setValue(METRIC_TOKEN)
    btn(w).focus()
    await btn(w).click()
    await flushPromises()
    expect(lastModel(w)).toBeUndefined() // nothing written: never half a token
    expect(textBox(w).value).toBe(full)
    expect(w.get('.label-full').text()).toBe('Label is full')
    expect(document.activeElement).toBe(textBox(w))
  })
})
