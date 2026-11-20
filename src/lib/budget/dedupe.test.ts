import { describe, expect, it } from 'vitest'
import { dedupeKey, occurrences, sha256Hex } from './dedupe'

const base = { accountId: 'chk-a', postedDate: '2026-11-20', amountCents: -450, clean: 'QUILLFEATHER CAFE', occurrence: 0 }

describe('occurrences', () => {
  it('numbers identical rows from zero and leaves different rows alone', () => {
    const rows = [
      { postedDate: '2026-11-20', amountCents: -450, clean: 'A' },
      { postedDate: '2026-11-20', amountCents: -450, clean: 'A' },
      { postedDate: '2026-11-20', amountCents: -450, clean: 'B' },
      { postedDate: '2026-11-21', amountCents: -450, clean: 'A' },
      { postedDate: '2026-11-20', amountCents: -450, clean: 'A' },
    ]
    expect(occurrences(rows)).toEqual([0, 1, 0, 0, 2])
  })
})

describe('dedupeKey', () => {
  it('is 32 lower-case hex characters and a pure function of its input', async () => {
    const k = await dedupeKey(base)
    expect(k).toMatch(/^[0-9a-f]{32}$/)
    expect(await dedupeKey({ ...base })).toBe(k)
  })
  it('separates same-day repeats by occurrence, accounts, dates and amounts', async () => {
    const keys = await Promise.all([base, { ...base, occurrence: 1 }, { ...base, accountId: 'sav-a' }, { ...base, postedDate: '2026-11-21' },
      { ...base, amountCents: -451 }, { ...base, clean: 'OTHER' }].map(dedupeKey))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('uses the bank reference alone when there is one', async () => {
    const a = await dedupeKey({ ...base, bankRef: 'REF-1' })
    const b = await dedupeKey({ ...base, clean: 'REWORDED', postedDate: '2026-11-22', bankRef: 'REF-1' })
    expect(a).toBe(b)
    expect(a).not.toBe(await dedupeKey(base))
    expect(await dedupeKey({ ...base, accountId: 'sav-a', bankRef: 'REF-1' })).not.toBe(a)
  })
  it('does not depend on the order rows arrive in', async () => {
    const rows = [
      { postedDate: '2026-11-20', amountCents: -450, clean: 'A' },
      { postedDate: '2026-11-20', amountCents: -450, clean: 'A' },
      { postedDate: '2026-11-21', amountCents: -100, clean: 'B' },
    ]
    const keysOf = async (rs: typeof rows) => {
      const occ = occurrences(rs)
      return (await Promise.all(rs.map((r, i) => dedupeKey({ accountId: 'chk-a', ...r, occurrence: occ[i] })))).sort()
    }
    expect(await keysOf([...rows].reverse())).toEqual(await keysOf(rows))
    expect(await keysOf([rows[2], rows[0], rows[1]])).toEqual(await keysOf(rows))
  })
  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
