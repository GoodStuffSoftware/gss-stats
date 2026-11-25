// @vitest-environment happy-dom
// The shared segmented control: the default size is unchanged; `compact` applies only when asked for.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedControl from './SegmentedControl.vue'

const OPTIONS = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]

describe('SegmentedControl size', () => {
  it('has no compact class by default or for size="default"', () => {
    expect(mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick' } }).classes()).toEqual(['seg'])
    expect(mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick', size: 'default' } }).classes()).toEqual(['seg'])
  })
  it('adds seg-compact only when size="compact"', () => {
    expect(mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick', size: 'compact' } }).classes()).toContain('seg-compact')
  })
})

describe('SegmentedControl collapsed', () => {
  it('is the radio buttons unless collapsed is set', () => {
    const w = mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick' } })
    expect(w.findAll('[role="radio"]')).toHaveLength(2)
    expect(w.find('select').exists()).toBe(false)
    expect(mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick', collapsed: false } }).find('select').exists()).toBe(false)
  })
  it('folds into one labelled dropdown with the same choices and value', () => {
    const w = mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'b', label: 'Pick', size: 'compact', collapsed: true } })
    const sel = w.get('select')
    expect(w.findAll('[role="radio"]')).toHaveLength(0)
    expect(sel.attributes('aria-label')).toBe('Pick')
    expect(sel.classes()).toContain('seg-compact')
    expect(w.findAll('option').map((o) => o.text())).toEqual(['A', 'B'])
    expect((sel.element as HTMLSelectElement).value).toBe('b')
  })
  it('emits the picked value from the dropdown', async () => {
    const w = mount(SegmentedControl, { props: { options: OPTIONS, modelValue: 'a', label: 'Pick', collapsed: true } })
    await w.get('select').setValue('b')
    expect(w.emitted('update:modelValue')).toEqual([['b']])
  })
})
