import { describe, expect, it } from 'vitest'
import { createFillRunner, loadRemainingPages, MAX_FILL_PAGES, type PagedModel } from './txnFill'

function fake(pages: number, fail = -1) {
  let left = pages
  const m: PagedModel & { calls: number } = {
    calls: 0,
    nextCursor: { value: left > 0 ? 'c0' : null },
    loadError: { value: null },
    loadMore: async () => {
      m.calls++
      if (m.calls - 1 === fail) {
        m.loadError.value = 'boom'
        return
      }
      left--
      m.nextCursor.value = left > 0 ? `c${m.calls}` : null
    },
  }
  return m
}

describe('loadRemainingPages', () => {
  it('fetches every remaining page, one request each', async () => {
    const m = fake(4)
    expect(await loadRemainingPages(m)).toBe(4)
    expect(m.calls).toBe(4)
    expect(m.nextCursor.value).toBeNull()
  })
  it('does nothing when the period is already fully loaded', async () => {
    const m = fake(0)
    expect(await loadRemainingPages(m)).toBe(0)
    expect(m.calls).toBe(0)
  })
  it('stops on an error', async () => {
    const m = fake(5, 1)
    await loadRemainingPages(m)
    expect(m.calls).toBe(2)
  })
  it('stops when the filters are cleared mid-way', async () => {
    const m = fake(5)
    let n = 0
    await loadRemainingPages(m, () => n++ < 2)
    expect(m.calls).toBe(2)
  })
  it('stops when loadMore makes no progress', async () => {
    const m = fake(3)
    m.loadMore = async () => {
      m.calls++
    }
    await loadRemainingPages(m)
    expect(m.calls).toBe(1)
  })
})

describe('createFillRunner', () => {
  it('starts one run per activation and period; syncs during the run start nothing', async () => {
    const m = fake(3)
    const r = createFillRunner(m, () => true)
    const run = r.sync('q1', false)!
    expect(r.sync('q1', false)).toBeNull() // the watcher firing after each page
    expect(r.sync('q1', false)).toBeNull()
    expect(await run).toBe(3)
    expect(m.calls).toBe(3)
    expect(r.sync('q1', false)).toBeNull() // finished: no second run for the same period
  })
  it('the page cap holds: a cursor that never ends stops at MAX_FILL_PAGES and does not restart', async () => {
    const m = fake(0)
    let n = 0
    m.nextCursor.value = 'c0'
    m.loadMore = async () => {
      m.calls++
      m.nextCursor.value = `c${++n}`
    }
    const r = createFillRunner(m, () => true)
    expect(await r.sync('q1', false)).toBe(MAX_FILL_PAGES)
    expect(r.sync('q1', false)).toBeNull()
    expect(m.calls).toBe(MAX_FILL_PAGES)
  })
  it('cancels on a new period, a fresh load and when the filters go off', async () => {
    const m = fake(5)
    let on = true
    const r = createFillRunner(m, () => on)
    const first = r.sync('q1', false)!
    const second = r.sync('q2', false)! // period changed while the first is going
    expect(await first).toBeLessThanOrEqual(1)
    expect(await second).toBeGreaterThan(0)
    const m2 = fake(5)
    const r2 = createFillRunner(m2, () => on)
    const run = r2.sync('q1', false)!
    on = false
    expect(r2.sync('q1', false)).toBeNull()
    expect(await run).toBeLessThanOrEqual(1)
    on = true
    expect(r2.sync('q1', true)).toBeNull() // a fresh load resets; the run restarts after it
    expect(r2.sync('q1', false)).not.toBeNull()
  })
})
