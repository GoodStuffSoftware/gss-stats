// @vitest-environment happy-dom
// The account in the header: the e-mail + "Sign out" form, and (in the compact band, picked by CSS)
// an account icon opening a menu with who is signed in and "Log out" — the same /auth/logout POST.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountMenu from './AccountMenu.vue'
import accountMenuSrc from './AccountMenu.vue?raw'
import appSrc from '../App.vue?raw'
import { signedInEmail } from '../session'
import { MOBILE_MAX_WIDTH, TOPBAR_COMPACT_MAX_WIDTH } from '../lib/responsive'

vi.mock('../session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}) }
})

let wrapper: VueWrapper | null = null
function mountMenu() {
  signedInEmail.value = 'mike@example.com'
  // attachTo: focus() and the document-level listeners need a real, connected tree
  wrapper = mount(AccountMenu, { attachTo: document.body })
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  signedInEmail.value = null
})

const btn = (w: VueWrapper) => w.get('button.account-btn')
const menu = (w: VueWrapper) => w.get('[role="menu"]')
const isOpen = (w: VueWrapper) => btn(w).attributes('aria-expanded') === 'true' && menu(w).isVisible()

describe('AccountMenu', () => {
  it('renders nothing until the signed-in account is known', () => {
    signedInEmail.value = null
    wrapper = mount(AccountMenu)
    expect(wrapper.find('.account-root').exists()).toBe(false)
  })

  it('keeps the e-mail + Sign out form, posting to /auth/logout', () => {
    const w = mountMenu()
    const form = w.get('form.account')
    expect(form.attributes()).toMatchObject({ method: 'post', action: '/auth/logout' })
    expect(form.text()).toContain('mike@example.com')
    expect(form.get('button[type="submit"]').text()).toBe('Sign out')
  })

  it('has an accessible account button that starts closed', () => {
    const w = mountMenu()
    expect(btn(w).attributes()).toMatchObject({ 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Account menu' })
    expect(isOpen(w)).toBe(false)
  })

  it('opens on click, shows who is signed in, and puts focus on "Log out"', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    expect(isOpen(w)).toBe(true)
    expect(menu(w).text()).toContain('mike@example.com')
    const item = menu(w).get('[role="menuitem"]')
    expect(item.text()).toBe('Log out')
    expect(document.activeElement).toBe(item.element)
    await btn(w).trigger('click')
    expect(isOpen(w)).toBe(false)
  })

  it('"Log out" is a submit of the same-origin /auth/logout form, not a new path', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    const form = menu(w).get('form')
    expect(form.attributes()).toMatchObject({ method: 'post', action: '/auth/logout' })
    expect(menu(w).get('[role="menuitem"]').attributes('type')).toBe('submit')
  })

  it('closes after choosing Log out, returning focus to the button, and keeps the form in the DOM to submit', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    await menu(w).get('form').trigger('submit')
    expect(isOpen(w)).toBe(false)
    expect(document.activeElement).toBe(btn(w).element)
    expect(w.find('[role="menu"] form').exists()).toBe(true)
  })

  it('closes on Escape and returns focus to the button', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(false)
    expect(document.activeElement).toBe(btn(w).element)
  })

  it('closes on a click outside, but not on a click inside the menu', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    menu(w).element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(true)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(false)
  })

  it('stops listening once unmounted', async () => {
    const w = mountMenu()
    const remove = vi.spyOn(document, 'removeEventListener')
    w.unmount()
    wrapper = null
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['pointerdown', 'keydown']))
    remove.mockRestore()
  })
})

// The icon/menu and the collapsed search are CSS, so happy-dom can't see them switch — pin that the
// stylesheets use the one band lib/responsive.ts names, just above the phone layout.
describe('compact top bar band', () => {
  const band = `@media (min-width: ${MOBILE_MAX_WIDTH + 1}px) and (max-width: ${TOPBAR_COMPACT_MAX_WIDTH}px)`
  it('AccountMenu and the search button share the same media query', () => {
    expect(accountMenuSrc).toContain(band)
    expect(appSrc).toContain(band)
  })
  it('sits above the phone layout and above where the bar wraps (~855px)', () => {
    expect(TOPBAR_COMPACT_MAX_WIDTH).toBeGreaterThan(MOBILE_MAX_WIDTH)
    expect(TOPBAR_COMPACT_MAX_WIDTH).toBeGreaterThanOrEqual(900)
  })
})
