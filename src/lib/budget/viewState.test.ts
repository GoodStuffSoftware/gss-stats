// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, onBeforeUnmount, onMounted } from 'vue'
import { MARK_KEY, readMark, readSteps } from './drillHistory'
import {
  DEBT_MARK_KEY, LOAN_MARK_KEY, defaultViewState, parseDebtSteps, parseDrillSteps, parseLoanSteps, monthsLabel, presetLabel, presetOf, rangeForPreset, rangeMonths, rangeValid, searchWithoutPath, searchWithState, stateFromSearch, summaryQueryOf, todayIso, txnQueryOf,
  hasExplicitViewState, restorePatch, savedViewOfState, useBudgetViewState, type BudgetViewState,
} from './viewState'
import { parseSavedView, type SavedView } from './savedView'

const TODAY = '2026-11-20'

describe('range presets', () => {
  it('computes each preset from today', () => {
    expect(rangeForPreset('this-month', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-20' })
    expect(rangeForPreset('last-month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(rangeForPreset('3-months', TODAY)).toEqual({ from: '2026-09-01', to: '2026-11-20' })
    expect(rangeForPreset('ytd', TODAY)).toEqual({ from: '2026-01-01', to: '2026-11-20' })
    expect(rangeForPreset('custom', TODAY)).toBeNull()
  })
  it('wraps the year in January and takes leap February', () => {
    expect(rangeForPreset('last-month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(rangeForPreset('3-months', '2026-02-10')).toEqual({ from: '2025-12-01', to: '2026-02-10' })
    expect(rangeForPreset('last-month', '2028-03-05')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
  it('names the preset a range is on, else custom', () => {
    expect(presetOf('2026-10-01', '2026-10-31', TODAY)).toBe('last-month')
    expect(presetOf('2026-11-01', '2026-11-20', TODAY)).toBe('this-month')
    expect(presetOf('2026-11-02', '2026-11-20', TODAY)).toBe('custom')
  })
  it('todayIso uses the local calendar date', () => {
    expect(todayIso(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05')
  })
})

describe('rangeValid', () => {
  it('accepts real ranges up to 400 days and refuses the rest', () => {
    expect(rangeValid('2026-11-01', '2026-11-01')).toBe(true)
    expect(rangeValid('2026-01-01', '2027-02-04')).toBe(true) // 400 days
    expect(rangeValid('2026-01-01', '2027-02-05')).toBe(false) // 401 days
    expect(rangeValid('2026-11-20', '2026-11-01')).toBe(false)
    expect(rangeValid('2026-02-30', '2026-03-01')).toBe(false)
    expect(rangeValid('nope', '2026-03-01')).toBe(false)
  })
})

describe('URL round trip', () => {
  it('{from,to,person,groupBy,reviewOnly,tab} survives state -> search -> state; the drill path is not in the URL', () => {
    const s: BudgetViewState = {
      from: '2026-09-01',
      to: '2026-10-31',
      person: 'p2',
      path: [],
      groupBy: 'merchant',
      reviewOnly: true,
      tab: 'debts',
      page: 'loans',
      loan: null,
      debt: null,
    }
    expect(stateFromSearch(searchWithState('', s), TODAY)).toEqual(s)
    const drilled: BudgetViewState = {
      ...s,
      path: [
        { level: 'category', key: 'groceries', label: 'Groceries' },
        { level: 'merchant', key: 'chain-x', label: 'Chain X & "Sons"' },
      ],
    }
    const written = searchWithState('', drilled)
    expect(written).toBe(searchWithState('', s)) // the path changes nothing in the address
    expect(written).not.toMatch(/groceries|chain|path/i)
    expect(stateFromSearch(written, TODAY).path).toEqual([])
    const acct: BudgetViewState = { ...s, groupBy: 'account', reviewOnly: false, tab: 'spending', person: 'all' }
    expect(stateFromSearch(searchWithState('', acct), TODAY)).toEqual(acct)
  })

  it('writes defaults out except the range, keeps other params, replaces old b_* params', () => {
    const d = defaultViewState(TODAY)
    const p = new URLSearchParams(searchWithState('?page=p1&section=budget&utm_source=x&b_person=old&b_tab=debts', d))
    expect(p.get('page')).toBe('p1')
    expect(p.get('section')).toBe('budget')
    expect(p.get('utm_source')).toBe('x')
    expect(p.get('b_from')).toBe('2026-11-01')
    expect(p.get('b_to')).toBe('2026-11-20')
    expect([...p.keys()].filter((k) => k.startsWith('b_')).sort()).toEqual(['b_from', 'b_to'])
  })

  it('malformed values fall back to the defaults', () => {
    const d = defaultViewState(TODAY)
    expect(stateFromSearch('?b_from=2026-13-01&b_to=2026-11-02', TODAY)).toEqual(d)
    expect(stateFromSearch('?b_from=2026-11-05&b_to=2026-11-01', TODAY)).toEqual(d)
    expect(stateFromSearch('?b_person=%3Cscript%3E', TODAY).person).toBe('all')
    expect(stateFromSearch('?b_tab=weird&b_group=weird&b_review=yes', TODAY)).toEqual(d)
  })

  it('an old link\'s b_path is ignored, and searchWithoutPath removes it, keeping every other param', () => {
    const old = `?section=budget&page=p1&b_path=${encodeURIComponent(JSON.stringify([['category', 'a', 'A']]))}&b_person=p2`
    expect(stateFromSearch(old, TODAY).path).toEqual([])
    expect(stateFromSearch(old, TODAY).person).toBe('p2')
    expect(searchWithoutPath(old)).toBe('?section=budget&page=p1&b_person=p2')
    expect(searchWithoutPath('?b_path=x')).toBe('')
    expect(searchWithoutPath('?section=budget')).toBe('?section=budget') // nothing to remove: untouched
    expect(searchWithoutPath('')).toBe('')
  })
})

describe('parseDrillSteps (what history.state may hold)', () => {
  const ok = [{ level: 'category', key: 'a', label: 'A' }, { level: 'merchant', key: 'b', label: 'B' }]
  it('accepts a path in level order, up to two steps; a missing label falls back to the key', () => {
    expect(parseDrillSteps([])).toEqual([])
    expect(parseDrillSteps(ok)).toEqual(ok)
    expect(parseDrillSteps([{ level: 'category', key: 'a' }])).toEqual([{ level: 'category', key: 'a', label: 'a' }])
  })
  it('refuses wrong level order, too deep, wrong shapes and oversize text', () => {
    expect(parseDrillSteps([{ level: 'merchant', key: 'a', label: 'A' }])).toBeNull()
    expect(parseDrillSteps([...ok, { level: 'merchant', key: 'c', label: 'C' }])).toBeNull()
    expect(parseDrillSteps([{ level: 'category', key: 5, label: 'A' }])).toBeNull()
    expect(parseDrillSteps([['category', 'a', 'A']])).toBeNull()
    expect(parseDrillSteps([{ level: 'category', key: '', label: 'A' }])).toBeNull()
    expect(parseDrillSteps([{ level: 'category', key: 'x'.repeat(121), label: 'A' }])).toBeNull()
    expect(parseDrillSteps('nope')).toBeNull()
    expect(parseDrillSteps(null)).toBeNull()
  })
})

describe('queries derived from the state', () => {
  const base = defaultViewState(TODAY)
  it('top level: range and person only', () => {
    expect(summaryQueryOf(base)).toEqual({ from: base.from, to: base.to, person: 'all' })
    expect(txnQueryOf(base)).toEqual({ from: base.from, to: base.to, person: 'all', scope: 'spending' })
  })
  it('category and merchant steps feed both queries identically', () => {
    const s: BudgetViewState = {
      ...base,
      person: 'p1',
      path: [{ level: 'category', key: 'fuel', label: 'Fuel' }, { level: 'merchant', key: 'chain-x', label: 'Chain X' }],
      reviewOnly: true,
    }
    expect(summaryQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'p1', category: 'fuel', groupBy: 'merchant', merchant: 'chain-x' })
    expect(txnQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'p1', scope: 'all', category: 'fuel', merchant: 'chain-x', review: true })
  })
  it('grouped by account, the second-level key is an account id: `account` (not `merchant`) in both queries', () => {
    const s: BudgetViewState = {
      ...base,
      groupBy: 'account',
      path: [{ level: 'category', key: 'fuel', label: 'Fuel' }, { level: 'merchant', key: 'acct-1', label: 'Card' }],
    }
    expect(summaryQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'all', category: 'fuel', groupBy: 'account', account: 'acct-1' })
    expect(txnQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'all', scope: 'spending', category: 'fuel', account: 'acct-1' })
    expect(txnQueryOf(s).merchant).toBeUndefined()
    expect(summaryQueryOf(s).merchant).toBeUndefined()
  })
  it('pie and table queries always agree on category / merchant / account, at every depth and grouping', () => {
    const steps = [
      { level: 'category', key: 'fuel', label: 'Fuel' },
      { level: 'merchant', key: 'k2', label: 'K2' },
    ] as const
    for (const groupBy of ['merchant', 'account'] as const) {
      for (let depth = 0; depth <= 2; depth++) {
        const s: BudgetViewState = { ...base, groupBy, path: steps.slice(0, depth).map((x) => ({ ...x })) }
        const a = summaryQueryOf(s)
        const b = txnQueryOf(s)
        expect([a.category, a.merchant, a.account]).toEqual([b.category, b.merchant, b.account])
      }
    }
  })
})

describe('useBudgetViewState', () => {
  beforeEach(() => history.replaceState(null, '', '/?section=budget&page=p1'))
  afterEach(() => history.replaceState(null, '', '/'))

  it('mirrors changes to the URL with replaceState, keeping other params', async () => {
    const len = history.length
    const v = useBudgetViewState(TODAY)
    v.setPerson('p2')
    v.pushStep({ level: 'category', key: 'dining', label: 'Dining' })
    v.setTab('debts')
    await nextTick()
    const p = new URLSearchParams(location.search)
    expect(p.get('section')).toBe('budget')
    expect(p.get('page')).toBe('p1')
    expect(p.get('b_person')).toBe('p2')
    expect(p.get('b_tab')).toBe('debts')
    expect(p.has('b_path')).toBe(false) // the drill path is not in the address
    expect(location.search).not.toMatch(/dining/i)
    expect(history.length).toBe(len)
  })

  it('starts from the URL it opens on', () => {
    history.replaceState(null, '', '/?section=budget&b_from=2026-01-01&b_to=2026-02-01&b_person=p2&b_tab=debts')
    const v = useBudgetViewState(TODAY)
    expect(v.state).toMatchObject({ from: '2026-01-01', to: '2026-02-01', person: 'p2', tab: 'debts' })
  })

  it('pushStep follows the level order; popTo goes back; groupBy change drops the second step', () => {
    const v = useBudgetViewState(TODAY)
    v.pushStep({ level: 'merchant', key: 'x', label: 'X' }) // wrong level first: ignored
    expect(v.state.path).toEqual([])
    v.pushStep({ level: 'category', key: 'fuel', label: 'Fuel' })
    v.pushStep({ level: 'merchant', key: 'chain-x', label: 'Chain X' })
    v.pushStep({ level: 'merchant', key: 'deeper', label: 'Deeper' }) // bottom: ignored
    expect(v.state.path.map((s) => s.key)).toEqual(['fuel', 'chain-x'])
    v.setGroupBy('account')
    expect(v.state.path.map((s) => s.key)).toEqual(['fuel'])
    v.pushStep({ level: 'merchant', key: 'acct-1', label: 'Card' })
    v.popTo(0)
    expect(v.state.path).toEqual([])
  })

  it('setRange refuses a range the server would refuse', () => {
    const v = useBudgetViewState(TODAY)
    expect(v.setRange('2026-11-10', '2026-11-01')).toBe(false)
    expect(v.setRange('2024-01-01', '2026-11-01')).toBe(false)
    expect(v.setRange('2026-10-01', '2026-10-31')).toBe(true)
    expect(v.state.from).toBe('2026-10-01')
  })

  it('does not write the URL once the section is no longer the open one', async () => {
    const v = useBudgetViewState(TODAY)
    history.replaceState(null, '', '/?page=p1') // App closed the section
    v.setPerson('p2')
    await nextTick()
    expect(location.search).toBe('?page=p1')
  })

  it('readUrl re-reads the address bar (back/forward)', () => {
    const v = useBudgetViewState(TODAY)
    history.replaceState(null, '', '/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31')
    v.readUrl()
    expect(v.state).toMatchObject({ person: 'p2', from: '2026-10-01', to: '2026-10-31' })
  })
})

// Back / Forward over the drill levels, in a mounted section (drillHistory.ts has the pure logic and its tests).
describe('useBudgetViewState: browser Back and Forward over the drill levels', () => {
  const FUEL = { level: 'category', key: 'fuel', label: 'Fuel' } as const
  const CHAIN = { level: 'merchant', key: 'chain-x', label: 'Chain X' } as const
  type View = ReturnType<typeof useBudgetViewState>
  // The way BudgetSection uses it: the composable, then its own popstate listener for readUrl (registered later).
  function mountSection() {
    let view!: View
    const w = mount(
      defineComponent({
        setup() {
          view = useBudgetViewState(TODAY)
          onMounted(() => window.addEventListener('popstate', view.readUrl))
          onBeforeUnmount(() => window.removeEventListener('popstate', view.readUrl))
          return () => null
        },
      }),
    )
    return { view, w }
  }
  const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }))
  const session = () => readMark(history.state)!.s

  beforeEach(() => history.replaceState(null, '', '/?section=budget&page=p1'))
  afterEach(() => {
    vi.restoreAllMocks()
    history.replaceState(null, '', '/')
  })

  it('marks the entry it opens on, in history.state only', () => {
    const { w } = mountSection()
    expect(readMark(history.state)).toMatchObject({ d: 0 })
    expect(location.search).not.toContain(MARK_KEY)
    w.unmount()
  })

  it('a drill pushes one entry per level; the address never changes and never names a level', async () => {
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    await nextTick()
    view.pushStep(FUEL)
    view.pushStep(CHAIN)
    await nextTick()
    expect(push).toHaveBeenCalledTimes(2)
    for (const call of push.mock.calls) {
      expect(call).toHaveLength(2) // state and title: no URL argument, so the address cannot change
    }
    expect(location.href).not.toMatch(/fuel|chain/i)
    // the steps ride in history.state (this tab's session history), which is not part of any URL
    expect(readMark(history.state)).toMatchObject({ d: 2 })
    expect(readSteps(history.state, parseDrillSteps)?.map((s) => s.key)).toEqual(['fuel', 'chain-x'])
    w.unmount()
  })

  it('never writes b_path to the address, and strips one an old link brought', async () => {
    history.replaceState(null, '', `/?section=budget&page=p1&b_path=${encodeURIComponent(JSON.stringify([['category', 'fuel', 'Fuel']]))}&b_person=p2`)
    const { view, w } = mountSection()
    expect(view.state.path).toEqual([]) // an old link's path is ignored
    expect(view.state.person).toBe('p2') // the other params stay
    expect(location.search).toBe('?section=budget&page=p1&b_person=p2')
    view.pushStep(FUEL)
    await nextTick()
    expect(location.search).not.toContain('b_path')
    expect(location.href).not.toMatch(/fuel/i)
    w.unmount()
  })

  it('a reload restores the drill path from history.state when it still parses', () => {
    history.replaceState(
      { [MARK_KEY]: { s: 'earlier-visit', d: 2, p: [{ level: 'category', key: 'fuel', label: 'Fuel' }, { level: 'merchant', key: 'chain-x', label: 'Chain X' }] } },
      '',
    )
    const { view, w } = mountSection()
    expect(view.state.path.map((s) => s.key)).toEqual(['fuel', 'chain-x'])
    expect(readMark(history.state)).toMatchObject({ d: 2 }) // adopted as this session's entry
    w.unmount()
  })

  it('a reload starts at the top when the state holds no path, a broken one, or one that disagrees with its depth', () => {
    for (const state of [
      null,
      { [MARK_KEY]: { s: 'x', d: 1 } },
      { [MARK_KEY]: { s: 'x', d: 1, p: 'junk' } },
      { [MARK_KEY]: { s: 'x', d: 2, p: [{ level: 'category', key: 'fuel', label: 'Fuel' }] } },
      { [MARK_KEY]: { s: 'x', d: 1, p: [{ level: 'merchant', key: 'chain-x', label: 'C' }] } },
    ]) {
      history.replaceState(state, '')
      const { view, w } = mountSection()
      expect(view.state.path).toEqual([])
      w.unmount()
    }
  })

  it('closing the section takes its mark off the entry, so a later open starts at the top', () => {
    const { view, w } = mountSection()
    view.pushStep(FUEL)
    expect(readMark(history.state)).toMatchObject({ d: 1 })
    w.unmount()
    expect(readMark(history.state)).toBeNull()
    const again = mountSection()
    expect(again.view.state.path).toEqual([])
    again.w.unmount()
  })

  it('Back (a popstate onto the entry below) cuts the path one level and leaves the range and person alone', async () => {
    const { view, w } = mountSection()
    view.pushStep(FUEL)
    view.pushStep(CHAIN)
    view.setPerson('p2')
    await nextTick()
    pop({ [MARK_KEY]: { s: session(), d: 1 } })
    expect(view.state.path.map((s) => s.key)).toEqual(['fuel'])
    expect(view.state.person).toBe('p2') // readUrl skipped: it would roll back to the older entry's address
    w.unmount()
  })

  it('Forward drills again with the remembered steps', () => {
    const { view, w } = mountSection()
    const s = session()
    view.pushStep(FUEL)
    view.pushStep(CHAIN)
    pop({ [MARK_KEY]: { s, d: 0 } })
    expect(view.state.path).toEqual([])
    pop({ [MARK_KEY]: { s, d: 1 } })
    expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
    pop({ [MARK_KEY]: { s, d: 2 } })
    expect(view.state.path.map((x) => x.key)).toEqual(['fuel', 'chain-x'])
    w.unmount()
  })

  it('a breadcrumb jump goes back over our own entries', () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    const { view, w } = mountSection()
    view.pushStep(FUEL)
    view.pushStep(CHAIN)
    view.popTo(0)
    expect(go).toHaveBeenCalledWith(-2)
    w.unmount()
  })

  it('an entry that is not this visit\'s is read from the address bar as before, and is not answered with new entries', async () => {
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    history.replaceState(null, '', '/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31')
    pop({ [MARK_KEY]: { s: 'an-older-visit', d: 1 } })
    expect(view.state).toMatchObject({ person: 'p2', from: '2026-10-01' })
    await new Promise((r) => setTimeout(r, 20)) // the popstate, a bounce go() and its landing all settle // the entry is adopted afterwards
    expect(readMark(history.state)).toMatchObject({ s: session(), d: 0 })
    expect(push).not.toHaveBeenCalled()
    w.unmount()
  })

  it('removes its listener when the section unmounts: a later popstate does nothing', () => {
    const { view, w } = mountSection()
    view.pushStep(FUEL)
    const s = session()
    w.unmount()
    pop({ [MARK_KEY]: { s, d: 0 } })
    expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
  })

  it('a bare call (no component) never touches history', () => {
    const push = vi.spyOn(history, 'pushState')
    const go = vi.spyOn(history, 'go')
    const v = useBudgetViewState(TODAY)
    v.pushStep(FUEL)
    v.popTo(0)
    expect(push).not.toHaveBeenCalled()
    expect(go).not.toHaveBeenCalled()
  })
})

describe('Budget pages: Overview and Loans', () => {
  type View = ReturnType<typeof useBudgetViewState>
  function mountSection() {
    let view!: View
    const w = mount(
      defineComponent({
        setup() {
          view = useBudgetViewState(TODAY)
          onMounted(() => window.addEventListener('popstate', view.readUrl))
          onBeforeUnmount(() => window.removeEventListener('popstate', view.readUrl))
          return () => null
        },
      }),
    )
    return { view, w }
  }
  const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }))
  beforeEach(() => history.replaceState(null, '', '/?section=budget&page=p1'))
  afterEach(() => {
    vi.restoreAllMocks()
    history.replaceState(null, '', '/')
  })

  it('reads b_page: only loans is Loans, anything else is Overview, and Overview writes nothing', () => {
    expect(stateFromSearch('?b_page=loans', TODAY).page).toBe('loans')
    expect(stateFromSearch('?b_page=bogus', TODAY).page).toBe('overview')
    expect(stateFromSearch('', TODAY).page).toBe('overview')
    expect(searchWithState('', defaultViewState(TODAY))).not.toContain('b_page')
    expect(searchWithState('', { ...defaultViewState(TODAY), page: 'loans' })).toContain('b_page=loans')
    expect(stateFromSearch('?b_loan=acct-1', TODAY).loan).toBeNull() // the open loan is never in the URL
    expect(searchWithState('', { ...defaultViewState(TODAY), page: 'loans', loan: 'acct-1' })).not.toContain('acct-1')
  })

  it('parseLoanSteps accepts one plain-id step and refuses the rest', () => {
    expect(parseLoanSteps([{ level: 'loan', key: 'acct-1' }])?.map((s) => s.key)).toEqual(['acct-1'])
    expect(parseLoanSteps([])).toEqual([])
    expect(parseLoanSteps([{ level: 'loan', key: 'a' }, { level: 'loan', key: 'b' }])).toBeNull()
    expect(parseLoanSteps([{ level: 'category', key: 'a' }])).toBeNull()
    expect(parseLoanSteps([{ level: 'loan', key: 'a b/../x' }])).toBeNull()
    expect(parseLoanSteps('x')).toBeNull()
  })

  it('setPage pushes exactly one entry with b_page in the address, and Back returns to Overview', async () => {
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    await nextTick()
    view.setPage('loans')
    await nextTick()
    expect(push).toHaveBeenCalledTimes(1)
    expect(view.state.page).toBe('loans')
    expect(view.state.loan).toBeNull()
    expect(new URLSearchParams(location.search).get('b_page')).toBe('loans')
    expect(new URLSearchParams(location.search).get('page')).toBe('p1') // other params kept
    history.replaceState(null, '', '/?section=budget&page=p1')
    pop(null)
    expect(view.state.page).toBe('overview')
    w.unmount()
  })

  it('setPage to the page already shown pushes nothing', async () => {
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    view.setPage('overview')
    expect(push).not.toHaveBeenCalled()
    w.unmount()
  })

  it('opening a loan from Overview is ONE entry: page and loan together; the loan is in history.state, not the URL', async () => {
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    expect(push).toHaveBeenCalledTimes(1)
    expect(view.state.loan).toBe('acct-1')
    expect(location.href).not.toContain('acct-1')
    expect(readSteps(history.state, parseLoanSteps, LOAN_MARK_KEY)?.map((s) => s.key)).toEqual(['acct-1'])
    w.unmount()
  })

  it('on the Loans page, opening a loan pushes one step of its own, again not in the URL', async () => {
    history.replaceState(null, '', '/?section=budget&b_page=loans')
    const push = vi.spyOn(history, 'pushState')
    const { view, w } = mountSection()
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    expect(push).toHaveBeenCalledTimes(1)
    expect(view.state.loan).toBe('acct-1')
    expect(location.search).not.toContain('acct-1')
    w.unmount()
  })

  it('a reload on the Loans page restores the open loan from history.state', () => {
    history.replaceState({ [LOAN_MARK_KEY]: { s: 'old', d: 1, p: [{ level: 'loan', key: 'acct-1', label: 'acct-1' }] } }, '', '/?section=budget&b_page=loans')
    const { view, w } = mountSection()
    expect(view.state.page).toBe('loans')
    expect(view.state.loan).toBe('acct-1')
    w.unmount()
  })

  it('Back onto an Overview entry from a Loans entry shows Overview and drops the loan', async () => {
    const { view, w } = mountSection()
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    history.replaceState(null, '', '/?section=budget&page=p1')
    pop(null)
    expect(view.state.page).toBe('overview')
    expect(view.state.loan).toBeNull()
    w.unmount()
  })
  it('Overview drilled -> slice -> Loans -> Overview -> crumb to the top never goes back onto the Loans entry', async () => {
    const go = vi.spyOn(history, 'go').mockImplementation(() => {})
    const { view, w } = mountSection()
    await nextTick()
    view.pushStep({ level: 'category', key: 'fuel', label: 'Fuel' })
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    view.setPage('overview')
    await nextTick()
    // the new Overview entry is marked with the drill path still on screen
    expect(readMark(history.state)).toMatchObject({ d: 1 })
    view.popTo(0)
    await nextTick()
    expect(go).not.toHaveBeenCalled()
    expect(view.state.page).toBe('overview')
    expect(view.state.path).toEqual([])
    expect(readMark(history.state)).toMatchObject({ d: 0 })
    w.unmount()
  })

  it('Back onto the Overview entry restores the drill as it was left', async () => {
    const { view, w } = mountSection()
    await nextTick()
    view.pushStep({ level: 'category', key: 'fuel', label: 'Fuel' })
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    view.setPage('overview')
    await nextTick()
    const overviewState = history.state
    expect(readSteps(overviewState, parseDrillSteps)?.map((x) => x.key)).toEqual(['fuel'])
    // Back to the Loans entry, then Forward onto the marked Overview entry: the drill is as it was left
    history.replaceState(null, '', '/?section=budget&b_page=loans&page=p1')
    pop({ [LOAN_MARK_KEY]: { s: 'x', d: 1, p: [{ level: 'loan', key: 'acct-1', label: 'acct-1' }] } })
    await nextTick()
    history.replaceState(overviewState, '', '/?section=budget&page=p1')
    pop(overviewState)
    await nextTick()
    expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
    expect(view.state.page).toBe('overview')
    w.unmount()
  })

  it('Back/Forward across loan entries of this session keeps the person chosen since', async () => {
    history.replaceState(null, '', '/?section=budget&b_page=loans')
    const { view, w } = mountSection()
    await nextTick()
    view.setPage('loans', 'acct-1')
    await nextTick()
    const loanState = history.state
    view.setPerson('p2')
    // an older entry's address names another person; this session's loan entry must not roll the filter back
    history.replaceState(loanState, '', '/?section=budget&b_page=loans&b_person=p1')
    pop(loanState)
    expect(view.state.person).toBe('p2')
    w.unmount()
  })

  describe('a reload between Overview (drilled) and a loan opened from the debt pie', () => {
    // A tiny session history over happy-dom's history/location: entries with state and address, a cursor, and
    // Back/Forward that move it the way a browser does (the entry's address and state, then an async popstate).
    function simBrowser() {
      const orig = { push: history.pushState.bind(history), replace: history.replaceState.bind(history) }
      const here = () => ({ state: history.state as unknown, url: location.pathname + location.search })
      const stack = [here()]
      let at = 0
      const popListeners: Array<(e: PopStateEvent) => void> = []
      const addListener = window.addEventListener.bind(window)
      const removeListener = window.removeEventListener.bind(window)
      vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: unknown, o?: unknown) => {
        if (type === 'popstate') popListeners.push(fn as (e: PopStateEvent) => void)
        else addListener(type, fn as EventListener, o as AddEventListenerOptions)
      })
      vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: unknown, o?: unknown) => {
        if (type === 'popstate') { const i = popListeners.indexOf(fn as (e: PopStateEvent) => void); if (i >= 0) popListeners.splice(i, 1) }
        else removeListener(type, fn as EventListener, o as EventListenerOptions)
      })
      vi.spyOn(history, 'pushState').mockImplementation((s, t, url) => {
        orig.push(s, t, url)
        stack.splice(at + 1)
        stack.push(here())
        at++
      })
      vi.spyOn(history, 'replaceState').mockImplementation((s, t, url) => {
        orig.replace(s, t, url)
        stack[at] = here()
      })
      vi.spyOn(history, 'go').mockImplementation((n = 0) => {
        const to = Math.max(0, Math.min(stack.length - 1, at + n))
        if (to === at) return
        at = to
        const e = stack[at]
        setTimeout(async () => {
          orig.replace(e.state, '', e.url)
          // like a browser's own dispatch: the reactive flush (a microtask checkpoint) runs between two listeners
          for (const fn of [...popListeners]) {
            fn(new PopStateEvent('popstate', { state: e.state }))
            await Promise.resolve()
            await nextTick()
          }
        }, 0)
      })
      return {
        go: async (n: number) => {
          history.go(n)
          await new Promise((r) => setTimeout(r, 20)) // the popstate, a bounce go() and its landing all settle
          await nextTick()
        },
        /** A reload: the entry the user is on keeps its state and address; the page and this section start over. */
        reload: (w: { unmount: () => void }) => {
          const kept = stack[at]
          w.unmount()
          orig.replace(kept.state, '', kept.url)
          stack[at] = kept
        },
        get length() {
          return stack.length
        },
        get at() {
          return at
        },
      }
    }
    const FUEL = { level: 'category', key: 'fuel', label: 'Fuel' } as const
    const bPage = () => new URLSearchParams(location.search).get('b_page')

    it('Back after the reload lands on Overview with its drill; Forward reopens the loan', async () => {
      const b = simBrowser()
      const first = mountSection()
      await nextTick()
      first.view.pushStep(FUEL)
      await nextTick()
      first.view.setPage('loans', 'acct-1')
      await nextTick()
      expect(b.length).toBe(3) // the section entry, one drill level, one Loans entry holding the loan: no more
      b.reload(first.w)
      const { view, w } = mountSection()
      await nextTick()
      expect(view.state.page).toBe('loans')
      expect(view.state.loan).toBe('acct-1')
      await b.go(-1)
      expect(bPage()).toBeNull()
      expect(view.state.page).toBe('overview')
      expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
      expect(view.state.loan).toBeNull()
      await b.go(1)
      expect(bPage()).toBe('loans')
      expect(view.state.page).toBe('loans')
      expect(view.state.loan).toBe('acct-1')
      w.unmount()
    })

    it('after the reload, Back twice then Forward twice walks the same entries, and the app never moves on its own', async () => {
      const b = simBrowser()
      const first = mountSection()
      await nextTick()
      first.view.pushStep(FUEL)
      await nextTick()
      first.view.setPage('loans', 'acct-1')
      await nextTick()
      b.reload(first.w)
      const { view, w } = mountSection()
      await nextTick()
      await b.go(-1)
      await b.go(-1)
      expect(b.at).toBe(0)
      expect(view.state.page).toBe('overview')
      expect(view.state.path).toEqual([])
      await b.go(1)
      expect(b.at).toBe(1) // stays on the entry Forward moved to (no bounce back)
      expect(view.state.page).toBe('overview')
      expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
      await b.go(1)
      expect(b.at).toBe(2)
      expect(bPage()).toBe('loans')
      expect(view.state.page).toBe('loans')
      expect(view.state.loan).toBe('acct-1')
      await b.go(-1) // and Back again from there
      expect(b.at).toBe(1)
      expect(view.state.page).toBe('overview')
      expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
      w.unmount()
    })

    it('a reload on a drilled Overview: Back then Forward re-opens the drill', async () => {
      const b = simBrowser()
      const first = mountSection()
      await nextTick()
      first.view.pushStep(FUEL)
      await nextTick()
      b.reload(first.w)
      const { view, w } = mountSection()
      await nextTick()
      expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
      await b.go(-1)
      expect(view.state.path).toEqual([])
      await b.go(1)
      expect(b.at).toBe(1)
      expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
      w.unmount()
    })

    it('a reload on a loan opened from the Loans list: Back closes it, Forward reopens it', async () => {
      const b = simBrowser()
      const first = mountSection()
      await nextTick()
      first.view.setPage('loans')
      await nextTick()
      first.view.setPage('loans', 'acct-1') // opened from the list: its own history step
      await nextTick()
      expect(b.length).toBe(3)
      b.reload(first.w)
      const { view, w } = mountSection()
      await nextTick()
      expect(view.state.loan).toBe('acct-1')
      await b.go(-1)
      expect(view.state.page).toBe('loans')
      expect(view.state.loan).toBeNull()
      await b.go(1)
      expect(b.at).toBe(2)
      expect(view.state.loan).toBe('acct-1')
      w.unmount()
    })

    it('without a reload, Loans list -> loan -> Back to Overview -> Forward twice reopens the loan', async () => {
      const b = simBrowser()
      const { view, w } = mountSection()
      await nextTick()
      view.setPage('loans')
      await nextTick()
      view.setPage('loans', 'acct-1')
      await nextTick()
      await b.go(-1)
      await b.go(-1)
      expect(view.state.page).toBe('overview')
      await b.go(1)
      expect(view.state.page).toBe('loans')
      expect(view.state.loan).toBeNull()
      await b.go(1)
      expect(b.at).toBe(2)
      expect(view.state.loan).toBe('acct-1')
      w.unmount()
    })

    describe('the debt drill (a debt opened in place from the debt pie)', () => {
      const debtOf = () => readSteps(history.state, parseDebtSteps, DEBT_MARK_KEY)?.map((x) => x.key)

      it('parseDebtSteps accepts one plain-id step and refuses the rest', () => {
        expect(parseDebtSteps([{ level: 'debt', key: 'acct-1' }])?.map((x) => x.key)).toEqual(['acct-1'])
        expect(parseDebtSteps([])).toEqual([])
        expect(parseDebtSteps([{ level: 'debt', key: 'a' }, { level: 'debt', key: 'b' }])).toBeNull()
        expect(parseDebtSteps([{ level: 'loan', key: 'a' }])).toBeNull()
        expect(parseDebtSteps([{ level: 'debt', key: 'a b/../x' }])).toBeNull()
        expect(parseDebtSteps('x')).toBeNull()
      })

      it('opens as ONE entry with the id in history.state and never in the address; a bad id opens nothing', async () => {
        const b = simBrowser()
        const { view, w } = mountSection()
        await nextTick()
        view.setDebt('a b/../x')
        await nextTick()
        expect(view.state.debt).toBeNull()
        expect(b.length).toBe(1)
        view.setDebt('acct-1')
        await nextTick()
        expect(view.state.debt).toBe('acct-1')
        expect(b.length).toBe(2)
        expect(debtOf()).toEqual(['acct-1'])
        expect(location.href).not.toContain('acct-1')
        expect(searchWithState('', view.state)).not.toContain('acct-1')
        w.unmount()
      })

      it('Back returns to the pie, Forward reopens the debt', async () => {
        const b = simBrowser()
        const { view, w } = mountSection()
        await nextTick()
        view.setDebt('acct-1')
        await nextTick()
        await b.go(-1)
        expect(view.state.debt).toBeNull()
        expect(view.state.page).toBe('overview')
        await b.go(1)
        expect(view.state.debt).toBe('acct-1')
        expect(b.at).toBe(1)
        w.unmount()
      })

      it('the crumb (setDebt null) steps back through history instead of stacking a new entry', async () => {
        const b = simBrowser()
        const { view, w } = mountSection()
        await nextTick()
        view.setDebt('acct-1')
        await nextTick()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          view.setDebt(null)
          await vi.advanceTimersByTimeAsync(20) // the popstate, a bounce go() and its landing all settle
        } finally {
          vi.useRealTimers()
        }
        await nextTick()
        expect(view.state.debt).toBeNull()
        expect(b.at).toBe(0)
        expect(b.length).toBe(2) // Forward still reopens it
        w.unmount()
      })

      it('a spending drill and a debt drill coexist: Back closes the debt first, then the spending step', async () => {
        const b = simBrowser()
        const { view, w } = mountSection()
        await nextTick()
        view.pushStep(FUEL)
        await nextTick()
        view.setDebt('acct-1')
        await nextTick()
        expect(b.length).toBe(3)
        await b.go(-1)
        expect(view.state.debt).toBeNull()
        expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
        await b.go(-1)
        expect(view.state.path).toEqual([])
        expect(view.state.debt).toBeNull()
        await b.go(1)
        expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
        expect(view.state.debt).toBeNull()
        await b.go(1)
        expect(view.state.debt).toBe('acct-1')
        expect(view.state.path.map((x) => x.key)).toEqual(['fuel'])
        w.unmount()
      })

      it('a reload on a drilled debt restores it from history.state; Back then closes it', async () => {
        const b = simBrowser()
        const first = mountSection()
        await nextTick()
        first.view.setDebt('acct-1')
        await nextTick()
        b.reload(first.w)
        const { view, w } = mountSection()
        await nextTick()
        expect(view.state.debt).toBe('acct-1')
        await b.go(-1)
        expect(view.state.debt).toBeNull()
        w.unmount()
      })

      it('opening the debt in Loans keeps the drill underneath: Back from Loans shows the drilled debt again', async () => {
        const b = simBrowser()
        const { view, w } = mountSection()
        await nextTick()
        view.setDebt('acct-1')
        await nextTick()
        view.setPage('loans', 'acct-1')
        await nextTick()
        expect(view.state.page).toBe('loans')
        await b.go(-1)
        expect(view.state.page).toBe('overview')
        expect(view.state.debt).toBe('acct-1')
        w.unmount()
      })
    })
  })
})

// The saved view: what it is built from, what a restore does and never does. All values are made up.
describe('saved view: build and restore patch', () => {
  const saved: SavedView = {
    hidden: 'debts',
    tab: 'debts',
    page: 'overview',
    path: [
      { level: 'category', key: 'fun', label: 'Fun' },
      { level: 'merchant', key: 'acme', label: 'Acme' },
    ],
    groupBy: 'account',
    review: true,
    debt: 'acct-1',
    range: { preset: 'last-month' },
    person: 'pat',
  }
  const ctx = { today: TODAY, categoryIds: ['fun', '__none__'], personIds: ['pat', 'sam'] }

  it('savedViewOfState carries the state and the Show choice; a preset range stays a preset', () => {
    const state: BudgetViewState = { ...defaultViewState(TODAY), tab: 'debts', person: 'pat', debt: 'acct-1', path: [{ level: 'category', key: 'fun', label: 'Fun' }], reviewOnly: true }
    expect(savedViewOfState(state, 'spending', TODAY)).toEqual({
      hidden: 'spending', tab: 'debts', page: 'overview', path: [{ level: 'category', key: 'fun', label: 'Fun' }], groupBy: 'merchant', review: true, debt: 'acct-1', range: { preset: 'this-month' }, person: 'pat',
    })
  })
  it('savedViewOfState keeps a custom range with its dates, trims long labels and drops a path it cannot save', () => {
    const r = { ...defaultViewState(TODAY), from: '2026-01-05', to: '2026-02-09', path: [{ level: 'category' as const, key: 'fun', label: 'L'.repeat(100) }] }
    const v = savedViewOfState(r, null, TODAY)
    expect(v.range).toEqual({ preset: 'custom', from: '2026-01-05', to: '2026-02-09' })
    expect(v.path[0].label).toHaveLength(60)
    const long = { ...defaultViewState(TODAY), path: [{ level: 'category' as const, key: 'k'.repeat(121), label: 'x' }] }
    expect(savedViewOfState(long, null, TODAY).path).toEqual([])
    expect(parseSavedView(savedViewOfState(r, null, TODAY), true)).not.toBeNull()
  })
  it('restorePatch: preset recomputed on today, the first step now and the second held back', () => {
    expect(restorePatch(saved, ctx)).toEqual({
      from: '2026-10-01', to: '2026-10-31', person: 'pat', groupBy: 'account', reviewOnly: true, tab: 'debts', page: 'overview',
      path: [{ level: 'category', key: 'fun', label: 'Fun' }], pendingStep: { level: 'merchant', key: 'acme', label: 'Acme' }, debt: 'acct-1',
    })
  })
  it('restorePatch: a category that is gone drops the whole drill; a person that is gone is all; a bad custom range is the default', () => {
    const p = restorePatch({ ...saved, person: 'gone', range: { preset: 'custom', from: '2026-05-01', to: '2025-01-01' } }, { ...ctx, categoryIds: ['other'] })
    expect(p.path).toEqual([])
    expect(p.pendingStep).toBeNull()
    expect(p.person).toBe('all')
    expect({ from: p.from, to: p.to }).toEqual(rangeForPreset('this-month', TODAY))
  })
  it('restorePatch: the uncategorised bucket is a valid first step; a custom range that is valid is kept; Loans keeps no debt', () => {
    const p = restorePatch({ ...saved, page: 'loans', path: [{ level: 'category', key: '__none__', label: 'Uncategorised' }], range: { preset: 'custom', from: '2026-09-01', to: '2026-09-30' } }, ctx)
    expect(p.path).toHaveLength(1)
    expect({ from: p.from, to: p.to }).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(p.debt).toBeNull()
  })
})

describe('saved view: precedence (a link or Back/Forward always wins)', () => {
  const saved: SavedView = {
    hidden: null, tab: 'debts', page: 'overview', path: [{ level: 'category', key: 'fun', label: 'Fun' }], groupBy: 'merchant', review: false, debt: null, range: { preset: '3-months' }, person: 'pat',
  }
  const ctx = { categoryIds: ['fun'], personIds: ['pat'] }
  afterEach(() => history.replaceState(null, '', '/'))

  it('hasExplicitViewState: any b_ param but b_page, or a drill, loan or debt mark', () => {
    expect(hasExplicitViewState('?section=budget', null)).toBe(false)
    expect(hasExplicitViewState('?section=budget&b_page=loans', null)).toBe(false)
    expect(hasExplicitViewState('?section=budget&b_from=2026-01-01&b_to=2026-02-01', null)).toBe(true)
    expect(hasExplicitViewState('?section=budget&b_tab=debts', null)).toBe(true)
    expect(hasExplicitViewState('?section=budget', { [MARK_KEY]: { s: 'x', d: 0 } })).toBe(true)
    expect(hasExplicitViewState('?section=budget', { [LOAN_MARK_KEY]: { s: 'x', d: 0 } })).toBe(true)
    expect(hasExplicitViewState('?section=budget', { [DEBT_MARK_KEY]: { s: 'x', d: 1 } })).toBe(true)
    expect(hasExplicitViewState('?section=budget', { unrelated: 1 })).toBe(false)
  })
  it('a bare open applies the saved view, once, and holds the second step', async () => {
    history.replaceState(null, '', '/?section=budget')
    const v = useBudgetViewState(TODAY)
    const withStep: SavedView = { ...saved, path: [...saved.path, { level: 'merchant', key: 'acme', label: 'Acme' }], debt: 'acct-1' }
    const r = v.restoreView(withStep, ctx)
    expect(r).toEqual({ applied: true, pendingStep: { level: 'merchant', key: 'acme', label: 'Acme' } })
    expect(v.state).toMatchObject({ tab: 'debts', person: 'pat', from: '2026-09-01', to: '2026-11-20', debt: 'acct-1' })
    expect(v.state.path.map((s) => s.key)).toEqual(['fun'])
    expect(v.restoreView({ ...saved, tab: 'spending' }, ctx).applied).toBe(false) // only once
    expect(v.state.tab).toBe('debts')
    await nextTick()
  })
  it('a link with b_ params wins: nothing is applied', () => {
    history.replaceState(null, '', '/?section=budget&b_from=2026-01-01&b_to=2026-02-01&b_person=sam')
    const v = useBudgetViewState(TODAY)
    expect(v.restoreView(saved, ctx)).toEqual({ applied: false, pendingStep: null })
    expect(v.state).toMatchObject({ from: '2026-01-01', to: '2026-02-01', person: 'sam', tab: 'spending', path: [] })
  })
  it('a history entry that carries a drill mark wins (reload, Back and Forward)', () => {
    history.replaceState({ [MARK_KEY]: { s: 'old', d: 0 } }, '', '/?section=budget')
    const v = useBudgetViewState(TODAY)
    expect(v.restoreView(saved, ctx).applied).toBe(false)
    expect(v.state.tab).toBe('spending')
  })
  it('b_page alone keeps the linked page and still restores the rest', () => {
    history.replaceState(null, '', '/?section=budget&b_page=loans')
    const v = useBudgetViewState(TODAY)
    expect(v.restoreView(saved, ctx).applied).toBe(true)
    expect(v.state).toMatchObject({ page: 'loans', tab: 'debts', person: 'pat' })
    expect(v.state.path).toEqual([]) // the drill is Overview's
  })
  it('a saved Loans page is restored and the debt is not', () => {
    history.replaceState(null, '', '/?section=budget')
    const v = useBudgetViewState(TODAY)
    v.restoreView({ ...saved, page: 'loans', debt: 'acct-1' }, ctx)
    expect(v.state).toMatchObject({ page: 'loans', debt: null })
  })
})

describe('month labels', () => {
  it('names one month, a span in one year, and a span across years', () => {
    expect(monthsLabel('2026-10-01', '2026-10-31')).toBe('October 2026')
    expect(monthsLabel('2026-08-01', '2026-10-31')).toBe('Aug – Oct 2026')
    expect(monthsLabel('2025-12-01', '2026-02-28')).toBe('Dec 2025 – Feb 2026')
    expect(monthsLabel('2026-08', '2026-10')).toBe('Aug – Oct 2026')
    expect(monthsLabel('2026-11-01', '2026-11-20', true)).toBe('November 2026 (to date)')
    expect(monthsLabel('nope', '2026-10-31')).toBe('')
    expect(monthsLabel('2026-00-01', '2026-10-31')).toBe('')
    expect(monthsLabel('2026-08-01', '2026-00-31')).toBe('')
  })
  it('rangeMonths adds to date only when the range runs to today', () => {
    expect(rangeMonths('2026-11-01', '2026-11-20', TODAY)).toBe('November 2026 (to date)')
    expect(rangeMonths('2026-10-01', '2026-10-31', TODAY)).toBe('October 2026')
    expect(rangeMonths('2026-09-01', '2026-11-20', TODAY)).toBe('Sep – Nov 2026 (to date)')
  })
  it('preset labels come from the preset range, across a year boundary too', () => {
    expect(presetLabel('last-month', TODAY)).toBe('Last month · October 2026')
    expect(presetLabel('3-months', TODAY)).toBe('Last 3 months · Sep – Nov 2026')
    expect(presetLabel('3-months', '2026-02-10')).toBe('Last 3 months · Dec 2025 – Feb 2026')
    expect(presetLabel('custom', TODAY)).toBe('Custom')
  })
})
