// @vitest-environment happy-dom
//
// Regression test for a naming collision vue-tsc caught (2026-09-28): the "Sync all pages"
// checkbox bound its `:checked`/`:class` to a bare `syncRange` identifier in the template,
// which in <script setup> resolved to a local `syncRange()` display-sync helper (always
// truthy as a function reference) instead of the `syncRange` boolean PROP that actually
// drives the toggle — so the checkbox always rendered checked regardless of state. The
// helper was renamed to `syncRangeDisplay` to remove the collision; these tests prove the
// checkbox now genuinely tracks the prop in both directions.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterBar from './FilterBar.vue'
import { defaultFilters } from '../lib/defaults'

function mountBar(syncRange: boolean) {
  return mount(FilterBar, { props: { filters: defaultFilters(), syncRange } })
}

describe('FilterBar — "Sync all pages" toggle reflects the syncRange prop', () => {
  it('renders unchecked when syncRange is false', () => {
    const w = mountBar(false)
    const checkbox = w.get('.sync-toggle input[type="checkbox"]').element as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(w.get('.sync-toggle').classes()).not.toContain('on')
  })

  it('renders checked when syncRange is true', () => {
    const w = mountBar(true)
    const checkbox = w.get('.sync-toggle input[type="checkbox"]').element as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    expect(w.get('.sync-toggle').classes()).toContain('on')
  })

  it('follows the prop when it changes after mount', async () => {
    const w = mountBar(false)
    await w.setProps({ syncRange: true })
    expect((w.get('.sync-toggle input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    await w.setProps({ syncRange: false })
    expect((w.get('.sync-toggle input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('emits toggleSync with the new checked state when clicked', async () => {
    const w = mountBar(false)
    await w.get('.sync-toggle input[type="checkbox"]').setValue(true)
    expect(w.emitted('toggleSync')).toEqual([[true]])
  })
})
