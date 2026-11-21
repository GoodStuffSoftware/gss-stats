// @vitest-environment happy-dom
// The searchable category list: filtering, keyboard, the Add choice and its roles. Made-up categories.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import CategorySelect from './CategorySelect.vue'
import type { SelectOption } from '../table/EditableTable.vue'

const OPTIONS: SelectOption[] = [
  { value: 'groceries', label: 'Groceries' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'dining', label: 'Dining out' },
  { value: 'u-pet-food', label: 'Pet food' },
  { value: '', label: 'Uncategorized' },
  { value: 'kind:transfer', label: 'Transfer', group: 'Not spending' },
  { value: 'kind:income', label: 'Income', group: 'Not spending' },
]

let w: VueWrapper | null = null
afterEach(() => {
  w?.unmount()
  w = null
})
function make(over: Record<string, unknown> = {}) {
  w = mount(CategorySelect, { props: { value: 'fuel', options: OPTIONS, color: '#E0722C', label: 'Category, Shop A', allowAdd: true, ...over }, attachTo: document.body })
  return w
}
const input = () => w!.get('input[role="combobox"]')
const labels = () => w!.findAll('[role="option"]').map((o) => o.text())
async function type(text: string) {
  const el = input().element as HTMLInputElement
  el.value = text
  await input().trigger('input')
}
const key = (k: string) => input().trigger('keydown', { key: k })

describe('CategorySelect roles', () => {
  it('is a combobox with a name, shows the current label and has no list until opened', () => {
    make()
    const i = input()
    expect(i.attributes('aria-label')).toBe('Category, Shop A')
    expect(i.attributes('aria-autocomplete')).toBe('list')
    expect(i.attributes('aria-expanded')).toBe('false')
    expect(i.attributes('aria-controls')).toBeUndefined()
    expect((i.element as HTMLInputElement).value).toBe('Fuel')
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
  })

  it('opened: the input controls a labelled listbox of options, the current one selected, groups labelled', async () => {
    make()
    await input().trigger('click')
    const list = w!.get('[role="listbox"]')
    expect(input().attributes('aria-expanded')).toBe('true')
    expect(input().attributes('aria-controls')).toBe(list.attributes('id'))
    expect(list.attributes('aria-label')).toBe('Category, Shop A choices')
    expect(labels()).toEqual(['Groceries', 'Fuel', 'Dining out', 'Pet food', 'Uncategorized', 'Transfer', 'Income'])
    const selected = w!.findAll('[role="option"]').filter((o) => o.attributes('aria-selected') === 'true')
    expect(selected.map((o) => o.text())).toEqual(['Fuel'])
    expect(w!.get('[role="group"]').attributes('aria-label')).toBe('Not spending')
    // the active option is the current one, named by aria-activedescendant
    const active = input().attributes('aria-activedescendant')
    expect(w!.get(`[id="${active}"]`).text()).toBe('Fuel')
  })
})

describe('CategorySelect search', () => {
  it('typing filters case-insensitively, matching anywhere in the name', async () => {
    make()
    await input().trigger('click')
    await type('OD')
    expect(labels().filter((l) => !l.startsWith('Add'))).toEqual(['Pet food']) // "od" is in the middle of "Pet food" only
    await type('ing')
    expect(labels().filter((l) => !l.startsWith('Add'))).toEqual(['Dining out'])
    await type('  fuel ')
    expect(labels()).toEqual(['Fuel'])
  })

  it('no match and no Add: says so; nothing to choose', async () => {
    make({ allowAdd: false })
    await input().trigger('click')
    await type('zzz')
    expect(labels()).toEqual([])
    expect(w!.text()).toContain('No matching category')
    await key('Enter')
    expect(w!.emitted('change')).toBeUndefined()
    expect(w!.emitted('add')).toBeUndefined()
  })

  it('clearing the text shows everything again', async () => {
    make()
    await input().trigger('click')
    await type('fu')
    await type('')
    expect(labels()).toHaveLength(7)
  })
})

describe('CategorySelect keyboard and mouse', () => {
  it('ArrowDown opens, arrows move (wrapping), Enter picks the active option', async () => {
    make({ value: 'groceries' })
    await key('ArrowDown')
    expect(input().attributes('aria-expanded')).toBe('true')
    await key('ArrowDown')
    await key('ArrowDown')
    await key('Enter')
    expect(w!.emitted('change')).toEqual([['dining']])
    expect(input().attributes('aria-expanded')).toBe('false')
    await key('ArrowDown') // opens on the current value (the first option)
    await key('ArrowUp') // up from the first wraps to the last
    await key('Enter')
    expect(w!.emitted('change')![1]).toEqual(['kind:income'])
  })

  it('typing then Enter picks the first match', async () => {
    make()
    await input().trigger('click')
    await type('pet')
    await key('Enter')
    expect(w!.emitted('change')).toEqual([['u-pet-food']])
  })

  it('Esc closes, keeps the old value and reports nothing', async () => {
    make()
    await input().trigger('click')
    await type('din')
    await key('Escape')
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
    expect((input().element as HTMLInputElement).value).toBe('Fuel')
    expect(w!.emitted('change')).toBeUndefined()
  })

  it('Tab and leaving the field close it without a change; picking the current value reports nothing', async () => {
    make()
    await input().trigger('click')
    await key('Tab')
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
    await input().trigger('click')
    await input().trigger('blur')
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
    await input().trigger('click')
    await key('Enter') // the active option is the current value
    expect(w!.emitted('change')).toBeUndefined()
  })

  it('a tap or click on an option picks it (touch emits click); a disabled option does not', async () => {
    make({ options: [...OPTIONS, { value: 'kind:card_payment', label: 'Card payment', group: 'Not spending', disabled: true }] })
    await input().trigger('click')
    await w!.findAll('[role="option"]').find((o) => o.text() === 'Card payment')!.trigger('click')
    expect(w!.emitted('change')).toBeUndefined()
    await w!.findAll('[role="option"]').find((o) => o.text() === 'Groceries')!.trigger('click')
    expect(w!.emitted('change')).toEqual([['groceries']])
  })

  it('a disabled field does not open', async () => {
    make({ disabled: true })
    await input().trigger('click')
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
  })
})

describe('CategorySelect "Add category"', () => {
  it('offers Add category "<text>" for text that matches nothing, last in the list, and Enter adds the trimmed name', async () => {
    make()
    await input().trigger('click')
    await type('  Boat   fees ')
    expect(labels()).toEqual(['Add category "Boat fees"'])
    expect(input().attributes('aria-activedescendant')).toBeTruthy()
    await key('Enter')
    expect(w!.emitted('add')).toEqual([['Boat fees']])
    expect(w!.emitted('change')).toBeUndefined()
    expect(w!.find('[role="listbox"]').exists()).toBe(false)
  })

  it('is offered after partial matches too, and clicking it adds', async () => {
    make()
    await input().trigger('click')
    await type('fuel tax')
    await type('Fu')
    expect(labels()).toEqual(['Fuel', 'Add category "Fu"'])
    await w!.findAll('[role="option"]')[1].trigger('click')
    expect(w!.emitted('add')).toEqual([['Fu']])
  })

  it('is not offered when the text equals an existing choice in any case (a built-in one included)', async () => {
    make()
    await input().trigger('click')
    for (const t of ['fuel', 'FUEL ', 'pet FOOD', 'income', 'Uncategorized']) {
      await type(t)
      expect(labels().some((l) => l.startsWith('Add category')), t).toBe(false)
    }
  })

  it('is not offered when the owner did not allow it, for empty text, or for a name that is too long', async () => {
    make({ allowAdd: false })
    await input().trigger('click')
    await type('Boat fees')
    expect(labels()).toEqual([])
    w!.unmount()
    make()
    await input().trigger('click')
    expect(labels().some((l) => l.startsWith('Add'))).toBe(false)
    await type('   ')
    expect(labels().some((l) => l.startsWith('Add'))).toBe(false)
    await type('x'.repeat(41))
    expect(labels()).toEqual([])
    expect(w!.text()).toContain('at most 40 characters')
  })
})
