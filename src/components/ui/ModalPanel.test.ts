// @vitest-environment happy-dom
// The shared modal shell: Esc, scrim, focus in and back, Tab trap, the sheet class and the body lock.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ModalPanel from './ModalPanel.vue'

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

function mountPanel(props: Record<string, unknown> = {}) {
  wrapper = mount(ModalPanel as never, {
    props: { open: true, title: 'Hello', ...props },
    slots: { default: '<button id="first">One</button><button id="last">Two</button>', actions: '<button id="act">Go</button>' },
    attachTo: document.body,
  } as never) as unknown as VueWrapper
  return wrapper
}

describe('ModalPanel', () => {
  it('draws a labelled modal dialog and moves focus to the first control', async () => {
    mountPanel()
    await nextTick()
    await nextTick()
    const dlg = document.querySelector('[role="dialog"]')!
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-labelledby')).toBe('mp-title')
    expect(document.getElementById('mp-title')?.textContent).toBe('Hello')
    expect(document.activeElement?.id).toBe('first')
  })
  it('Esc and the scrim emit close', async () => {
    const w = mountPanel()
    await nextTick()
    document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    ;(document.querySelector('.mp-scrim') as HTMLElement).click()
    expect(w.emitted('close')).toHaveLength(2)
  })
  it('Tab wraps at both ends', async () => {
    mountPanel()
    await nextTick()
    await nextTick()
    const dlg = document.querySelector('[role="dialog"]')!
    ;(document.getElementById('act') as HTMLElement).focus()
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement?.id).toBe('first')
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement?.id).toBe('act')
  })
  it('gives focus back to the opener on close', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const w = mountPanel({ open: false })
    await w.setProps({ open: true })
    await nextTick()
    await nextTick()
    await w.setProps({ open: false })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(opener)
  })
  it('fires returnLost when the opener is gone', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const w = mountPanel({ open: false })
    await w.setProps({ open: true })
    await nextTick()
    opener.remove()
    await w.setProps({ open: false })
    await nextTick()
    await nextTick()
    expect(w.emitted('returnLost')).toHaveLength(1)
  })
  it('the sheet option sets the class and locks body scroll while open; wide sets its class', async () => {
    const w = mountPanel({ sheet: true, wide: true })
    await nextTick()
    const cls = document.querySelector('.mp-panel')!.classList
    expect(cls.contains('mp-sheet') && cls.contains('mp-wide')).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    await w.setProps({ open: false })
    expect(document.body.style.overflow).toBe('')
  })
  it('draws nothing when closed', () => {
    mountPanel({ open: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
