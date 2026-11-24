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
