// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SmartDateRange from './SmartDateRange.vue'

const TODAY = '2026-11-27'
function mountField(over: Record<string, unknown> = {}) {
  return mount(SmartDateRange, {
    props: { from: '2026-11-01', to: '2026-11-27', today: TODAY, maxDays: 400, testid: 'sd', ...over },
    attachTo: document.body,
  })
}
const input = (w: ReturnType<typeof mountField>) => w.get('[data-testid="sd-input"]')
async function type(w: ReturnType<typeof mountField>, text: string) {
  await input(w).setValue(text)
}
const day = (w: ReturnType<typeof mountField>, d: string) => w.get(`button[data-date="${d}"]`)

describe('SmartDateRange: typing', () => {
  it('shows the current dates as text', () => {
    expect((input(mountField()).element as HTMLInputElement).value).toBe('Nov 1 – Nov 27, 2026')
    expect((input(mountField({ from: '2026-11-03', to: '2026-11-03' })).element as HTMLInputElement).value).toBe('Nov 3, 2026')
  })

  it('shows what it understood while typing, before anything applies', async () => {
    const w = mountField()
    await type(w, 'Oct 1 to Nov 15')
    expect(w.get('[data-testid="sd-note"]').text()).toBe('Understood: Oct 1 – Nov 15, 2026')
    expect(w.emitted('change')).toBeUndefined()
  })

  it('Enter applies the dates', async () => {
    const w = mountField()
    await type(w, 'last 7 days')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toEqual([[{ from: '2026-11-21', to: '2026-11-27' }]])
  })

  it('leaving the field applies the dates', async () => {
    const w = mountField()
    await type(w, 'March 2025')
    await input(w).trigger('blur')
    expect(w.emitted('change')).toEqual([[{ from: '2025-03-01', to: '2025-03-31' }]])
  })

  it('a single date emits one day', async () => {
    const w = mountField()
    await type(w, '11/3')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toEqual([[{ from: '2026-11-03', to: '2026-11-03' }]])
  })

  it('text it cannot read shows a hint, restores the current dates and emits nothing', async () => {
    const w = mountField()
    await type(w, 'blorp')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toBeUndefined()
    expect(w.get('[data-testid="sd-hint"]').text()).toContain('Couldn\'t read "blorp"')
    expect((input(w).element as HTMLInputElement).value).toBe('Nov 1 – Nov 27, 2026')
  })

  it('a range longer than maxDays shows a hint and emits nothing', async () => {
    const w = mountField()
    await type(w, 'since 2024')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toBeUndefined()
    expect(w.get('[data-testid="sd-hint"]').text()).toContain('at most 400 days')
  })

  it('typing the dates already shown emits nothing, and blank text keeps the dates', async () => {
    const w = mountField()
    await type(w, 'this month')
    await input(w).trigger('keydown', { key: 'Enter' })
    await type(w, '   ')
    await input(w).trigger('blur')
    expect(w.emitted('change')).toBeUndefined()
    expect(w.find('[data-testid="sd-hint"]').exists()).toBe(false)
  })

  it('Escape drops the typed text', async () => {
    const w = mountField()
    await type(w, 'yesterday')
    await w.get('.sdr').trigger('keydown', { key: 'Escape' })
    expect((input(w).element as HTMLInputElement).value).toBe('Nov 1 – Nov 27, 2026')
    expect(w.emitted('change')).toBeUndefined()
  })
})

describe('SmartDateRange: review fixes', () => {
  afterEach(() => vi.useRealTimers())
  const calBtn = (w: ReturnType<typeof mountField>) => w.get('[data-testid="sd-calendar"]')

  it('re-reads the clock after midnight (a tab left open does not keep yesterday)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 27, 23, 59, 0))
    // No `today` prop: the field reads the real clock.
    const w = mountField({ today: undefined, from: '2020-01-01', to: '2020-01-02' })
    await type(w, 'today')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')!.at(-1)).toEqual([{ from: '2026-11-27', to: '2026-11-27' }])

    vi.setSystemTime(new Date(2026, 10, 28, 0, 1, 0))
    await input(w).trigger('focus')
    await type(w, 'today')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')!.at(-1)).toEqual([{ from: '2026-11-28', to: '2026-11-28' }])
  })

  it('Tab reaches the days after changing months (exactly one day is a tab stop)', async () => {
    const w = mountField()
    await calBtn(w).trigger('click')
    await w.get('[data-testid="cal-next"]').trigger('click')
    const stops = w.findAll('button.dc-day[tabindex="0"]')
    expect(stops).toHaveLength(1)
    expect(w.get('[data-testid="cal-title"]').text()).toBe('December 2026')
    expect(stops[0].attributes('data-date')).toBe('2026-12-01')
    await w.get('[data-testid="cal-prev"]').trigger('click')
    await w.get('[data-testid="cal-prev"]').trigger('click')
    expect(w.findAll('button.dc-day[tabindex="0"]')).toHaveLength(1)
  })

  it('arrow keys do not move focus onto a day that cannot be picked', async () => {
    const w = mountField({ min: '2026-11-01', max: '2026-11-27', from: '2026-11-27', to: '2026-11-27' })
    await calBtn(w).trigger('click')
    await w.get('[role="grid"]').trigger('keydown', { key: 'ArrowRight' }) // Nov 28 is past max
    expect(day(w, '2026-11-27').attributes('tabindex')).toBe('0')
    expect(w.get('[data-testid="cal-title"]').text()).toBe('November 2026')
  })

  it('the calendar opens on a pickable month when today is outside min..max', async () => {
    const w = mountField({ from: '', to: '', min: '2026-10-01', max: '2026-10-31' })
    await calBtn(w).trigger('click')
    expect(w.get('[data-testid="cal-title"]').text()).toBe('October 2026')
    expect(w.findAll('button.dc-day[tabindex="0"]')).toHaveLength(1)
    expect((w.get('button.dc-day[tabindex="0"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('absurd typed text shows a hint and does not throw', async () => {
    const w = mountField()
    await type(w, 'last 5000 years')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('change')).toBeUndefined()
    expect(w.get('[data-testid="sd-hint"]').text()).toContain('Couldn\'t read')
  })
})

describe('SmartDateRange: calendar', () => {
  async function openCal(w: ReturnType<typeof mountField>) {
    await w.get('[data-testid="sd-calendar"]').trigger('click')
  }

  it('the button opens a calendar on the current month with today marked', async () => {
    const w = mountField()
    expect(w.find('[data-testid="date-calendar"]').exists()).toBe(false)
    await openCal(w)
    expect(w.get('[data-testid="cal-title"]').text()).toBe('November 2026')
    expect(day(w, TODAY).attributes('aria-current')).toBe('date')
  })

  it('one click picks a single date; the same day again finishes and closes', async () => {
    const w = mountField()
    await openCal(w)
    await day(w, '2026-11-10').trigger('click')
    expect(w.emitted('change')).toEqual([[{ from: '2026-11-10', to: '2026-11-10' }]])
    expect(w.find('[data-testid="date-calendar"]').exists()).toBe(true) // open for a second click
    await day(w, '2026-11-10').trigger('click')
    expect(w.emitted('change')).toHaveLength(1) // still just the one date
    expect(w.find('[data-testid="date-calendar"]').exists()).toBe(false)
  })

  it('two different days pick a range, in either order, and close', async () => {
    const w = mountField()
    await openCal(w)
    await day(w, '2026-11-20').trigger('click')
    await day(w, '2026-11-05').trigger('click')
    expect(w.emitted('change')!.at(-1)).toEqual([{ from: '2026-11-05', to: '2026-11-20' }])
    expect(w.find('[data-testid="date-calendar"]').exists()).toBe(false)
  })

  it('the pending range highlights while hovering', async () => {
    const w = mountField()
    await openCal(w)
    await day(w, '2026-11-10').trigger('click')
    await day(w, '2026-11-14').trigger('mouseenter')
    const marked = w.findAll('button.dc-day.sel').map((b) => b.attributes('data-date'))
    expect(marked).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'])
  })

  it('month navigation, then a range across two months', async () => {
    const w = mountField()
    await openCal(w)
    await w.get('[data-testid="cal-prev"]').trigger('click')
    expect(w.get('[data-testid="cal-title"]').text()).toBe('October 2026')
    await day(w, '2026-10-28').trigger('click')
    await w.get('[data-testid="cal-next"]').trigger('click')
    await day(w, '2026-11-03').trigger('click')
    expect(w.emitted('change')!.at(-1)).toEqual([{ from: '2026-10-28', to: '2026-11-03' }])
  })

  it('the Today button returns to the current month', async () => {
    const w = mountField()
    await openCal(w)
    await w.get('[data-testid="cal-prev"]').trigger('click')
    await w.get('[data-testid="cal-today"]').trigger('click')
    expect(w.get('[data-testid="cal-title"]').text()).toBe('November 2026')
  })

  it('arrow keys move the focus a day or a week, PageUp a month; Enter picks', async () => {
    const w = mountField()
    await openCal(w)
    const grid = w.get('[role="grid"]')
    await grid.trigger('keydown', { key: 'ArrowRight' }) // focus starts on the range's start, Nov 1
    expect(day(w, '2026-11-02').attributes('tabindex')).toBe('0')
    await grid.trigger('keydown', { key: 'ArrowDown' })
    expect(day(w, '2026-11-09').attributes('tabindex')).toBe('0')
    await grid.trigger('keydown', { key: 'PageUp' })
    expect(w.get('[data-testid="cal-title"]').text()).toBe('October 2026')
    expect(day(w, '2026-10-09').attributes('tabindex')).toBe('0')
    await day(w, '2026-10-09').trigger('click') // Enter on a button is a click
    expect(w.emitted('change')).toEqual([[{ from: '2026-10-09', to: '2026-10-09' }]])
  })

  it('Escape closes the calendar without changing anything', async () => {
    const w = mountField()
    await openCal(w)
    await w.get('.sdr').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-testid="date-calendar"]').exists()).toBe(false)
    expect(w.emitted('change')).toBeUndefined()
  })

  it('days beyond maxDays from the first click are disabled', async () => {
    const w = mountField({ maxDays: 10 })
    await openCal(w)
    await day(w, '2026-11-10').trigger('click')
    expect((day(w, '2026-11-19').element as HTMLButtonElement).disabled).toBe(false)
    expect((day(w, '2026-11-20').element as HTMLButtonElement).disabled).toBe(true)
  })
})
