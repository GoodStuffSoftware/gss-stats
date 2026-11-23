// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { tipPlacement, useToggletip } from './useToggletip'

describe('tipPlacement', () => {
  it('sits under a trigger in the upper part of the screen, inside the margins', () => {
    expect(tipPlacement({ left: 10, top: 100, bottom: 120 }, 400, 800)).toEqual({ left: '10px', width: '320px', top: '126px' })
  })
  it('goes above a trigger in the lower part, and stays inside a narrow screen', () => {
    expect(tipPlacement({ left: 300, top: 700, bottom: 720 }, 360, 800)).toEqual({ left: '32px', width: '320px', bottom: '106px' })
    expect(tipPlacement({ left: 0, top: 700, bottom: 720 }, 200, 800).width).toBe('184px')
  })
})

describe('useToggletip', () => {
  let wrapper: ReturnType<typeof mount> | null = null
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })
  function setup() {
    let api!: ReturnType<typeof useToggletip<string>>
    wrapper = mount(
      defineComponent({
        setup() {
          api = useToggletip<string>('.trig, .tipbox')
          return () => h('div', [h('button', { class: 'trig' }), h('p', { class: 'other' })])
        },
      }),
      { attachTo: document.body },
    )
    const el = wrapper.get('.trig').element as HTMLElement
    return { api, el }
  }
  const tick = () => wrapper!.vm.$nextTick()

  it('toggles by key: same key closes, another key moves it', () => {
    const { api, el } = setup()
    api.toggle('a', 'A', el)
    expect(api.tip.value?.data).toBe('A')
    api.toggle('b', 'B', el)
    expect(api.tip.value?.key).toBe('b')
    api.toggle('b', 'B', el)
    expect(api.tip.value).toBeNull()
  })
  it('closes on Escape, an outside pointer-down, a scroll and a resize, but not on a trigger', async () => {
    const { api, el } = setup()
    const open = async () => {
      api.openAt('a', 'A', el)
      await tick()
    }
    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(api.tip.value).toBeNull()
    await tick()
    await open()
    wrapper!.get('.trig').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(api.tip.value).not.toBeNull()
    wrapper!.get('.other').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(api.tip.value).toBeNull()
    await tick()
    await open()
    window.dispatchEvent(new Event('scroll'))
    expect(api.tip.value).toBeNull()
    await tick()
    await open()
    window.dispatchEvent(new Event('resize'))
    expect(api.tip.value).toBeNull()
  })
  it('keyboard focus opens only for :focus-visible', () => {
    const { api, el } = setup()
    el.matches = () => false
    api.openOnKeyboardFocus('a', 'A', el)
    expect(api.tip.value).toBeNull()
    el.matches = () => true
    api.openOnKeyboardFocus('a', 'A', el)
    expect(api.tip.value?.key).toBe('a')
  })
})
