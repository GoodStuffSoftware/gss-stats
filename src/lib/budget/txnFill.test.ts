import { describe, expect, it } from 'vitest'
import { loadRemainingPages, type PagedModel } from './txnFill'

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
