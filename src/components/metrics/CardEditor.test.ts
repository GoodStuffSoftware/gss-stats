// @vitest-environment happy-dom
//
// Mounting tests for CardEditor.vue (ADR 0003 slice 6). editorModel.test.ts already covers the
// pure draft <-> CardSpec mapping in isolation; these confirm the .vue wiring: emitting only
// valid CardRefs, the preset -> customize -> edit -> emit flow, section/item reordering through
// real button clicks, the display compatibility matrix as seen through the UI, that an invalid
// ratio literally cannot be picked, and that a prototype-named id can't be typed into existence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import CardEditor from './CardEditor.vue'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { validateCard } from '../../lib/metrics/validate'
import { RATIOS } from '../../lib/metrics/ratios'
import type { CardRef, CardSpec } from '../../lib/metrics/types'

const mounted: VueWrapper[] = []
function mountEditor(modelValue: CardRef) {
  const wrapper = mount(CardEditor, { props: { modelValue } })
  mounted.push(wrapper)
  return wrapper
}
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

function lastEmitted(wrapper: VueWrapper): CardRef {
  const events = wrapper.emitted('update:modelValue')
  expect(events).toBeTruthy()
  return events![events!.length - 1][0] as CardRef
}
/** Every 'update:modelValue' this wrapper has emitted so far must pass validateCard (a preset
 * CardRef is "valid" iff it resolves, checked the same way CardEditor itself does). */
function assertEveryEmissionValid(wrapper: VueWrapper) {
  for (const [ref] of wrapper.emitted('update:modelValue') ?? []) {
    const r = ref as CardRef
    if ('spec' in r) expect(validateCard(r.spec)).toEqual([])
  }
}

describe('preset mode', () => {
  it('starts from a { preset } modelValue and emits it straight back (already valid)', async () => {
    const wrapper = mountEditor({ preset: 'campaign-scorecard' })
    await flushPromises()
    expect(lastEmitted(wrapper)).toEqual({ preset: 'campaign-scorecard' })
    assertEveryEmissionValid(wrapper)
  })

  it('an unknown preset id shows an inline error and never emits', async () => {
    const wrapper = mountEditor({ preset: 'not-a-real-preset' })
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.text()).toContain('Unknown preset')
  })
})

describe('preset -> customize -> edit -> emit', () => {
  // bsk-kpis has no card-level title of its own, so the "Card title" checkbox starts unchecked
  // (campaign-scorecard's title is already set to a `{ bind }`, which would make the same
  // checkbox click turn it OFF instead of on).
  it('Customize copies the preset into an editable spec, and a further edit emits a valid { spec }', async () => {
    const wrapper = mountEditor({ preset: 'bsk-kpis' })
    await flushPromises()
    await wrapper.find('button.btn').trigger('click') // "Customize…" is the editor's first .btn
    await flushPromises()

    const emittedAfterCustomize = lastEmitted(wrapper)
    expect('spec' in emittedAfterCustomize).toBe(true)

    // Turn on the card title and type into it — a real edit past the initial copy.
    const titleCheckbox = wrapper.findAll('.field.check input[type=checkbox]')[0]
    await titleCheckbox.setValue(true)
    await flushPromises()
    const titleInput = wrapper.find('input[placeholder="Card title"]')
    await titleInput.setValue('US+CA web retest')
    await flushPromises()

    const final = lastEmitted(wrapper) as { spec: CardSpec }
    expect(final.spec.title).toBe('US+CA web retest')
    expect(validateCard(final.spec)).toEqual([])
    assertEveryEmissionValid(wrapper)
  })

  it('Reset to preset discards the customization', async () => {
    const wrapper = mountEditor({ preset: 'bsk-kpis' })
    await flushPromises()
    await wrapper.find('button.btn').trigger('click') // Customize…
    await flushPromises()
    const titleCheckbox = wrapper.findAll('.field.check input[type=checkbox]')[0]
    await titleCheckbox.setValue(true)
    await flushPromises()
    expect((lastEmitted(wrapper) as { spec: CardSpec }).spec.title).toBe('')

    const resetBtn = wrapper.findAll('button').find((b) => b.text() === 'Reset to preset')!
    await resetBtn.trigger('click')
    await flushPromises()
    const afterReset = lastEmitted(wrapper) as { spec: CardSpec }
    expect(afterReset.spec.title).toBeUndefined()
  })
})

describe('section and item reordering', () => {
  function twoSectionSpec(): CardSpec {
    return {
      v: 1,
      sections: [
        { layout: 'rows', items: [{ id: 'a', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] },
        { layout: 'rows', items: [{ id: 'b', label: 'Spend', data: { metric: 'campaign.spend' }, display: { as: 'currency' } }] },
      ],
      repeat: { over: 'campaigns' },
    }
  }
  it('moving the first section down swaps section order in the emitted spec', async () => {
    const wrapper = mountEditor({ spec: twoSectionSpec() })
    await flushPromises()
    await wrapper.find('[title="Move section down"]').trigger('click')
    await flushPromises()
    const spec = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(spec.sections[0].items[0].id).toBe('b')
    expect(spec.sections[1].items[0].id).toBe('a')
    assertEveryEmissionValid(wrapper)
  })

  function twoItemSpec(): CardSpec {
    return {
      v: 1,
      sections: [
        {
          layout: 'rows',
          items: [
            { id: 'a', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } },
            { id: 'b', label: 'Spend', data: { metric: 'campaign.spend' }, display: { as: 'currency' } },
          ],
        },
      ],
      repeat: { over: 'campaigns' },
    }
  }
  it('moving the first item down swaps item order within its section', async () => {
    const wrapper = mountEditor({ spec: twoItemSpec() })
    await flushPromises()
    await wrapper.find('[title="Move down"]').trigger('click')
    await flushPromises()
    const spec = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(spec.sections[0].items.map((i) => i.id)).toEqual(['b', 'a'])
    assertEveryEmissionValid(wrapper)
  })

  it('duplicating an item inserts a copy with a fresh id right after it', async () => {
    const wrapper = mountEditor({ spec: twoItemSpec() })
    await flushPromises()
    await wrapper.find('[title="Duplicate"]').trigger('click')
    await flushPromises()
    const spec = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(spec.sections[0].items).toHaveLength(3)
    expect(spec.sections[0].items[0].id).toBe('a')
    expect(spec.sections[0].items[1].id).not.toBe('a')
    expect(spec.sections[0].items[1].data).toEqual(spec.sections[0].items[0].data)
    assertEveryEmissionValid(wrapper)
  })

  it('removing an item leaves the rest, still a valid card', async () => {
    const wrapper = mountEditor({ spec: twoItemSpec() })
    await flushPromises()
    await wrapper.find('[title="Remove"]').trigger('click')
    await flushPromises()
    const spec = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(spec.sections[0].items.map((i) => i.id)).toEqual(['b'])
    assertEveryEmissionValid(wrapper)
  })
})

describe('display compatibility matrix, as seen through the UI', () => {
  function pairItemSpec(): CardSpec {
    return {
      v: 1,
      repeat: { over: 'campaigns' },
      sections: [{ layout: 'pills', items: [{ id: 'a', label: 'x', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }],
    }
  }
  it('switching an item to a pair ratio leaves only "counts" selectable, never "percent"', async () => {
    const wrapper = mountEditor({ spec: pairItemSpec() })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click') // expand the item
    await wrapper.find('.tab:not(.active)').trigger('click') // "Ratio" tab (Metric is active first)
    // Ratio tabs order: Metric, Ratio, Field — click the one labelled "Ratio".
    const dataTabs = wrapper.findAll('.tab')
    const ratioTab = dataTabs.find((t) => t.text() === 'Ratio')!
    await ratioTab.trigger('click')
    await flushPromises()

    const pairOption = wrapper.findAll('.option-row').find((r) => r.text().includes('Game-screen views vs arrivals'))!
    await pairOption.trigger('click')
    await flushPromises()

    const displayTabs = wrapper.findAll('[role="radiogroup"] .tab')
    const asValues = displayTabs.map((t) => t.text().replace(' (coming soon)', ''))
    expect(asValues).toEqual(['counts'])
    expect(asValues).not.toContain('percent')

    const spec = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(spec.sections[0].items[0].display.as).toBe('counts')
    assertEveryEmissionValid(wrapper)
  })
})

describe('an invalid ratio is impossible to construct from the UI', () => {
  it('the ratio picker lists exactly the registered RATIOS, nothing hand-built or free-form', async () => {
    const wrapper = mountEditor({
      spec: { v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'x', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }] },
    })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click')
    const ratioTab = wrapper.findAll('.tab').find((t) => t.text() === 'Ratio')!
    await ratioTab.trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.option-row')
    expect(rows.length).toBe(RATIOS.size)
  })

  it('typing "constructor" into the ratio search matches nothing — no option can be fabricated from text', async () => {
    const wrapper = mountEditor({
      spec: { v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'x', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }] },
    })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click')
    const ratioTab = wrapper.findAll('.tab').find((t) => t.text() === 'Ratio')!
    await ratioTab.trigger('click')
    await flushPromises()
    await wrapper.find('input[placeholder="Search ratios…"]').setValue('constructor')
    await flushPromises()
    expect(wrapper.findAll('.option-row')).toHaveLength(0)
    expect(wrapper.text()).toContain('No ratio matches')
  })
})

describe('prototype-named ids can never be selected or injected via text fields', () => {
  it('the metric search for "constructor"/"__proto__" matches nothing real', async () => {
    const wrapper = mountEditor({
      spec: { v: 1, repeat: { over: 'campaigns' }, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'x', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }] },
    })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click')
    for (const q of ['constructor', '__proto__', 'toString']) {
      await wrapper.find('input[placeholder="Search metrics…"]').setValue(q)
      await flushPromises()
      expect(wrapper.findAll('.option-row')).toHaveLength(0)
    }
  })

  it('a spec hand-crafted with a prototype-named metric id never crashes the editor, and is flagged invalid', async () => {
    const spec: CardSpec = { v: 1, sections: [{ layout: 'rows', items: [{ id: 'a', label: 'x', data: { metric: 'constructor' }, display: { as: 'number' } }] }] }
    expect(() => mountEditor({ spec })).not.toThrow()
    const wrapper = mounted[mounted.length - 1]
    await flushPromises()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined() // never emitted: it can't validate
    expect(wrapper.text()).toContain('error')
  })
})

describe('label kinds round-trip through the UI', () => {
  it('switching an item label from Text to Note to Bound field to Metric\'s own keeps the item valid at each stop', async () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns' },
      sections: [{ layout: 'rows', items: [{ id: 'a', label: 'Arrivals', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }],
    }
    const wrapper = mountEditor({ spec })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click')

    const labelTabs = () => wrapper.findAll('.tabs')[0].findAll('.tab')

    // Note — switching kind alone leaves an empty (unknown) note id, which validateCard
    // correctly rejects, so no NEW emission happens until a real note is chosen (the emission
    // gate working as designed, not a bug: CardEditor never emits a half-finished edit).
    await labelTabs()[2].trigger('click')
    await flushPromises()
    expect(lastEmitted(wrapper)).toEqual({ spec }) // unchanged: still the last VALID state
    // Scoped to the item body: the card-level Repeat picker (rendered earlier in the DOM) is
    // also a `.field select`, and a global `find` would grab that one instead. 'small-sample' is
    // a real 'note'-kind entry ('flight-pending' is a 'label'-kind id, correctly absent from
    // this picker — see noteLabelOptions' own test coverage).
    await wrapper.find('.ce-item-body .field select').setValue('small-sample')
    await flushPromises()
    let s = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(s.sections[0].items[0].label).toEqual({ note: 'small-sample' })

    // Bound field — every offered path is a real, pre-selected ScopePath, so this is valid
    // immediately.
    await labelTabs()[3].trigger('click')
    await flushPromises()
    s = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect('bind' in (s.sections[0].items[0].label as object)).toBe(true)

    // Metric's own
    await labelTabs()[1].trigger('click')
    await flushPromises()
    s = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(s.sections[0].items[0].label).toEqual({ metric: true })

    // Back to text
    await labelTabs()[0].trigger('click')
    await flushPromises()
    s = (lastEmitted(wrapper) as { spec: CardSpec }).spec
    expect(typeof s.sections[0].items[0].label).toBe('string')

    assertEveryEmissionValid(wrapper)
  })
})

describe('every emitted value passes validateCard, across a mixed sequence of edits', () => {
  it('add section, add item, edit fields, reorder — every intermediate emission is valid', async () => {
    const wrapper = mountEditor({ preset: 'bsk-kpis' })
    await flushPromises()
    await wrapper.find('button.btn').trigger('click') // Customize…
    await flushPromises()
    const addSectionBtn = wrapper.findAll('button').find((b) => b.text() === '+ Add section')!
    await addSectionBtn.trigger('click')
    await flushPromises()
    const addItemBtns = wrapper.findAll('button').filter((b) => b.text() === '+ Add item')
    await addItemBtns[addItemBtns.length - 1].trigger('click')
    await flushPromises()
    assertEveryEmissionValid(wrapper)
    expect((wrapper.emitted('update:modelValue') ?? []).length).toBeGreaterThan(1)
  })
})

describe('context prop', () => {
  it('is forwarded to the live preview (the same page filters a saved card would see)', async () => {
    const context = { since: '2026-09-01', until: '2026-09-27', sites: ['bestsudoku-web'] }
    const wrapper = mount(CardEditor, { props: { modelValue: { preset: 'campaign-scorecard' } as CardRef, context } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.findComponent(MetricCard).props('context')).toEqual(context)

    const changed = { since: '2026-09-10', until: '2026-09-27' }
    await wrapper.setProps({ context: changed })
    await flushPromises()
    expect(wrapper.findComponent(MetricCard).props('context')).toEqual(changed)
  })
})

describe('a11y: every form control has an accessible name', () => {
  /** Every visible text-entry control (input/select/textarea) must resolve a name via one of:
   * aria-label, aria-labelledby (pointing at real, non-empty text), a wrapping <label>, or
   * for/id pairing with some <label> in the document — the same rule axe-core's
   * "label"/"select-name" checks apply. Buttons are excluded: a <button>'s own text IS its
   * accessible name (every tab/reorder/duplicate/remove control here has visible text). */
  function accessibleNameProblems(wrapper: VueWrapper): string[] {
    const root = wrapper.element as HTMLElement
    const problems: string[] = []
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if ((el as HTMLInputElement).type === 'hidden') continue
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel?.trim()) continue
      const labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy && labelledBy.split(/\s+/).every((id) => (document.getElementById(id) ?? root.querySelector(`#${CSS.escape(id)}`))?.textContent?.trim())) continue
      const id = el.getAttribute('id')
      if (id && root.querySelector(`label[for="${CSS.escape(id)}"]`)) continue
      if (el.closest('label')) continue
      const path = (() => {
        const bits: string[] = []
        let n: Element | null = el
        while (n && bits.length < 4) {
          bits.unshift(n.tagName.toLowerCase() + (n.getAttribute('class') ? `.${n.getAttribute('class')!.split(' ')[0]}` : ''))
          n = n.parentElement
        }
        return bits.join(' > ')
      })()
      problems.push(`${path} (name="${(el as HTMLInputElement).name || ''}" placeholder="${el.getAttribute('placeholder') || ''}")`)
    }
    return problems
  }

  it('a fully-expanded editor (badge on, item open, "more" open, whenEmpty=note) has no unnamed control', async () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns' },
      title: 'US+CA web retest',
      badge: { data: { field: 'campaign.statusToday' }, display: { as: 'badge' } },
      captions: ['small-sample'],
      sections: [
        {
          layout: 'rows',
          title: 'Funnel',
          items: [
            {
              id: 'a',
              label: 'Arrivals',
              caption: { note: 'small-sample' },
              data: { metric: 'campaign.taggedArrivals' },
              display: { as: 'number' },
              gating: { whenUnmeasured: 'label', whenEmpty: { note: 'small-sample' }, minCohort: 10 },
            },
          ],
        },
      ],
    }
    const wrapper = mountEditor({ spec })
    await flushPromises()
    await wrapper.find('.ce-item-summary').trigger('click') // expand the item
    await flushPromises()
    const more = wrapper.find('details.more')
    ;(more.element as HTMLDetailsElement).open = true
    await flushPromises()

    const problems = accessibleNameProblems(wrapper)
    expect(problems).toEqual([])
  })
})
