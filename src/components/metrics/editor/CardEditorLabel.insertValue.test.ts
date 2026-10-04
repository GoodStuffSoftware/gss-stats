// @vitest-environment happy-dom
//
// A card label's "+ Insert variable…" and the chart caption's "Insert value" are ONE control and
// one vocabulary (notes plan slice 1d, release 2): the repeat's own fields insert `{campaign.label}`
// exactly as before, and the fixed dates insert `{=…}` tokens that a card label then fills in.
// Insertion is the explicit Insert button (review N3), never the select's change.
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CardEditorLabel from './CardEditorLabel.vue'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
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
    expect(menu(w).findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Fields', 'Dates'])
    const values = menu(w).findAll('option').map((o) => o.attributes('value'))
    expect(values).toContain('{campaign.label}')
    expect(values).toContain('{=golive.web|date}')
    expect(values.some((v) => v?.startsWith('{=chart.') || v?.startsWith('{=metric:'))).toBe(false) // a card label has no chart and fetches nothing
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

  it('with no repeat there are no fields, only the dates', () => {
    const w = open('Hello')
    expect(menu(w).findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Dates'])
  })
})
