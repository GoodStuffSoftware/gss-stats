// @vitest-environment happy-dom
// The account in the header: the e-mail + "Sign out" form, and (in the compact band, picked by CSS)
// an account icon opening a menu with who is signed in and "Log out" — the same /auth/logout POST.
// happy-dom has no layout and does not apply @media rules to computed styles, so the stylesheet
// tests read the rules out of the component sources and evaluate their conditions with
// matchMedia (which happy-dom does implement, range syntax included) at chosen viewport widths.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AccountMenu from './AccountMenu.vue'
import accountMenuSrc from './AccountMenu.vue?raw'
import appSrc from '../App.vue?raw'
import { signedInEmail } from '../session'
import { MOBILE_MAX_WIDTH, TOPBAR_COMPACT_MAX_WIDTH, TOPBAR_COMPACT_QUERY } from '../lib/responsive'

vi.mock('../session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}) }
})

const win = window as unknown as Window & { happyDOM: { setViewport(v: { width: number; height: number }): void } }
const setWidth = (width: number) => win.happyDOM.setViewport({ width, height: 800 })

let wrapper: VueWrapper | null = null
function mountMenu() {
  signedInEmail.value = 'mike@example.com'
  // attachTo: focus() and the document-level listeners need a real, connected tree
  wrapper = mount(AccountMenu, { attachTo: document.body })
  return wrapper
}
beforeEach(() => setWidth(800)) // inside the compact band, where the icon menu is the account
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  signedInEmail.value = null
  vi.restoreAllMocks()
})

const btn = (w: VueWrapper) => w.get('button.account-btn')
const menu = (w: VueWrapper) => w.get('[role="menu"]')
const popup = (w: VueWrapper) => w.get('#account-menu')
const isOpen = (w: VueWrapper) => btn(w).attributes('aria-expanded') === 'true' && popup(w).isVisible()
const pressEscape = () => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  document.dispatchEvent(e)
  return e
}

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

  it('has an accessible account button that starts closed and controls a real element', () => {
    const w = mountMenu()
    expect(btn(w).attributes()).toMatchObject({
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-label': 'Account menu',
      title: 'Account',
    })
    expect(isOpen(w)).toBe(false)
    const controlled = document.getElementById(btn(w).attributes('aria-controls')!)
    expect(controlled).toBe(popup(w).element)
    expect(controlled!.contains(menu(w).element)).toBe(true)
  })

  it('opens on click, shows who is signed in, and puts focus on "Log out"', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    expect(isOpen(w)).toBe(true)
    expect(popup(w).text()).toContain('mike@example.com')
    // the role="menu" holds only menu items; the "signed in as" text sits beside it
    expect(menu(w).text()).toBe('Log out')
    expect(menu(w).findAll('[role="menuitem"]')).toHaveLength(1)
    expect(document.activeElement).toBe(menu(w).get('[role="menuitem"]').element)
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
    expect(pressEscape().defaultPrevented).toBe(true)
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(false)
    expect(document.activeElement).toBe(btn(w).element)
  })

  it('leaves Escape alone while it is closed', () => {
    mountMenu()
    expect(pressEscape().defaultPrevented).toBe(false)
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

  it('closes when focus moves outside it (Tab away, or another control taking focus), not within it', async () => {
    const w = mountMenu()
    const other = document.createElement('button')
    document.body.appendChild(other)
    await btn(w).trigger('click')
    const item = menu(w).get('[role="menuitem"]').element
    item.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: btn(w).element }))
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(true)
    item.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: other }))
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(false)
    other.remove()
  })

  it('removes exactly the document listeners it added, on unmount', () => {
    const adds = vi.spyOn(document, 'addEventListener')
    const removes = vi.spyOn(document, 'removeEventListener')
    const w = mountMenu()
    const added = adds.mock.calls.filter((c) => c[0] === 'pointerdown' || c[0] === 'keydown')
    expect(added.map((c) => c[0]).sort()).toEqual(['keydown', 'pointerdown'])
    w.unmount()
    wrapper = null
    for (const [type, fn] of added) expect(removes).toHaveBeenCalledWith(type, fn)
  })

  it('does nothing on Escape after it is unmounted', async () => {
    const w = mountMenu()
    await btn(w).trigger('click')
    w.unmount()
    wrapper = null
    expect(pressEscape().defaultPrevented).toBe(false)
  })
})

// Leaving the compact band while the menu is open (a foldable unfolding, a window resize): CSS hides the
// menu, so the open state, its focus and the Escape handler must not outlive it. The viewport is driven
// through a controllable matchMedia so each `change` the browser would fire is explicit.
type Listener = (e: { matches: boolean }) => void
function fakeBand() {
  const listeners = new Set<Listener>()
  const queries: string[] = []
  const added: Listener[] = []
  const removed: Listener[] = []
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({
        matches: true,
        media: q,
        addEventListener: (type: string, fn: Listener) => {
          if (type !== 'change') return
          queries.push(q)
          added.push(fn)
          listeners.add(fn)
        },
        removeEventListener: (type: string, fn: Listener) => {
          if (type !== 'change') return
          removed.push(fn)
          listeners.delete(fn)
        },
      }) as unknown as MediaQueryList,
  )
  return {
    queries,
    added,
    removed,
    listeners,
    change(matches: boolean) {
      for (const fn of [...listeners]) fn({ matches })
    },
  }
}

describe('AccountMenu across the band edge', () => {
  it('listens to the shared band query', () => {
    const band = fakeBand()
    mountMenu()
    expect(band.queries).toEqual([TOPBAR_COMPACT_QUERY])
  })

  it('closes when the viewport leaves the band, handing focus to the inline Sign out', async () => {
    const band = fakeBand()
    const w = mountMenu()
    await btn(w).trigger('click')
    expect(document.activeElement).toBe(menu(w).get('[role="menuitem"]').element)
    band.change(false)
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(btn(w).attributes('aria-expanded')).toBe('false')
    expect(popup(w).isVisible()).toBe(false)
    expect(document.activeElement).toBe(w.get('form.account button[type="submit"]').element)
    expect(pressEscape().defaultPrevented).toBe(false) // the document Escape handler stands down
  })

  it('does not steal focus the viewer has already moved elsewhere', async () => {
    const band = fakeBand()
    const w = mountMenu()
    const other = document.createElement('input')
    document.body.appendChild(other)
    await btn(w).trigger('click')
    other.focus() // closes it via focusout; the later band change must not pull focus back
    await w.vm.$nextTick()
    band.change(false)
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('ignores a change that stays in the band, and a change while closed', async () => {
    const band = fakeBand()
    const w = mountMenu()
    band.change(false) // closed: nothing to do, and no focus theft
    await w.vm.$nextTick()
    expect(document.activeElement).not.toBe(w.get('form.account button[type="submit"]').element)
    await btn(w).trigger('click')
    band.change(true)
    await w.vm.$nextTick()
    expect(isOpen(w)).toBe(true)
  })

  it('removes the band listener it added, on unmount', () => {
    const band = fakeBand()
    const w = mountMenu()
    expect(band.added).toHaveLength(1)
    w.unmount()
    wrapper = null
    expect(band.removed).toEqual(band.added)
    expect(band.listeners.size).toBe(0)
  })
})

// ── The stylesheet side: which layout shows at which width ──────────────────────────────────────
// Pull the plain rules and the @media rules out of a component's <style>, then ask matchMedia whether a
// condition holds at a width and what a selector's `display` then is.
type MediaRule = { cond: string; body: string }
function styleOf(src: string): string {
  return src.slice(src.indexOf('<style'), src.lastIndexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '')
}
function parseStyle(src: string): { base: string; media: MediaRule[] } {
  const css = styleOf(src)
  const media: MediaRule[] = []
  let base = ''
  for (let i = 0; i < css.length; ) {
    const at = css.indexOf('@media', i)
    if (at < 0) {
      base += css.slice(i)
      break
    }
    base += css.slice(i, at)
    const open = css.indexOf('{', at)
    let depth = 1
    let j = open + 1
    while (depth && j < css.length) {
      depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0
      j++
    }
    media.push({ cond: css.slice(at + 6, open).trim().replace(/\s+/g, ' '), body: css.slice(open + 1, j - 1) })
    i = j
  }
  return { base, media }
}
function display(css: string, selector: string): string | null {
  let out: string | null = null
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' '))
    if (selectors.includes(selector)) out = /display:\s*([a-z-]+)/.exec(m[2])?.[1] ?? out
  }
  return out
}
// The display a selector ends up with at a viewport width: its plain rule, then each @media rule whose condition holds.
function displayAt(src: string, selector: string, width: number): string | null {
  setWidth(width)
  const { base, media } = parseStyle(src)
  let d = display(base, selector)
  for (const m of media) if (window.matchMedia(m.cond).matches) d = display(m.body, selector) ?? d
  return d
}
// Widths on both sides of every edge, whole and fractional (browser zoom, scaled displays).
const WIDTHS = [320, 375, 700, 700.1, 700.4, 700.5, 700.9, 701, 768, 853, 1000, 1000.4, 1000.5, 1001, 1280]
const inBand = (w: number) => w > MOBILE_MAX_WIDTH && w <= TOPBAR_COMPACT_MAX_WIDTH

describe('stylesheet: the compact band', () => {
  it('the band query is the exact complement of the phone layout query, with no gap or overlap', () => {
    for (const w of WIDTHS) {
      setWidth(w)
      const phone = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches
      const band = window.matchMedia(TOPBAR_COMPACT_QUERY).matches
      const above = w > TOPBAR_COMPACT_MAX_WIDTH
      expect([w, +phone + +band + +above]).toEqual([w, 1]) // exactly one of phone / band / wide
      expect(band).toBe(inBand(w))
    }
  })

  it('AccountMenu: the e-mail + Sign out form at phone and wide widths, the icon menu in the band', () => {
    for (const w of WIDTHS) {
      expect([w, displayAt(accountMenuSrc, '.account', w)]).toEqual([w, inBand(w) ? 'none' : 'flex'])
      expect([w, displayAt(accountMenuSrc, '.account-compact', w)]).toEqual([w, inBand(w) ? 'block' : 'none'])
    }
  })

  it('AccountMenu carries the same band text as lib/responsive.ts', () => {
    const conds = parseStyle(accountMenuSrc).media.map((m) => m.cond)
    expect(conds).toContain(TOPBAR_COMPACT_QUERY)
  })

  it('the search button is an icon (label and "/" hint hidden) in the band and in the phone layout, full above it', () => {
    for (const w of WIDTHS) {
      const collapsed = w <= TOPBAR_COMPACT_MAX_WIDTH
      expect([w, displayAt(appSrc, '.nav-search-label', w)]).toEqual([w, collapsed ? 'none' : null])
      expect([w, displayAt(appSrc, '.nav-search-btn kbd', w)]).toEqual([w, collapsed ? 'none' : null])
    }
  })
})
