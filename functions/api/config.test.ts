// The KV backup that functions/api/config.ts takes before a newer layout version overwrites an
// older stored config (see its header). A Map stands in for the STATS_CONFIG namespace.
// Also the rolling `:prev` copy and the daily `:day:<ET date>` snapshot written before any save
// that changes the stored layout (the server-side backstop to the client's load guard).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPut, backupKeyFor, PREV_KEY, dayKeyFor, DAY_SNAPSHOT_TTL_SECONDS } from './config'
import { CONFIG_VERSION, LAYOUT_VERSIONS } from '../../src/lib/defaults'

// Every test runs at a fixed instant (only Date is faked), so the daily snapshot key is known:
// 2026-10-03 12:00 EDT.
const NOW = Date.parse('2026-10-03T16:00:00Z')
const DAY = dayKeyFor('2026-10-03')
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const puts: string[] = []
  const options = new Map<string, unknown>()
  return {
    store,
    puts,
    options,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, opts?: unknown) => {
        puts.push(k)
        if (opts !== undefined) options.set(k, opts)
        store.set(k, v)
      },
    },
  }
}
async function put(kv: any, body: unknown) {
  const ctx = { request: { text: async () => JSON.stringify(body) }, env: { STATS_CONFIG: kv } } as any
  return onRequestPut(ctx)
}
const cfg = (version: number, tag = '') => ({ version, activePageId: 'x', pages: [{ id: 'x', tag }] })

describe('config PUT backs up the stored config on a version bump', () => {
  it('copies the older config to its backup key before saving the newer one', async () => {
    const old = JSON.stringify(cfg(8, 'old'))
    const { kv, store } = fakeKv({ 'dashboard:default': old })
    const res = await put(kv, cfg(9, 'new'))
    expect(res.status).toBe(200)
    expect(store.get(backupKeyFor(8))).toBe(old)
    expect(JSON.parse(store.get('dashboard:default')!).version).toBe(9)
  })

  it('never overwrites an existing backup, and writes no version backup on a same-version save', async () => {
    const { kv, store, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(8, 'second')), [backupKeyFor(8)]: 'first' })
    await put(kv, cfg(9))
    expect(store.get(backupKeyFor(8))).toBe('first')
    puts.length = 0
    await put(kv, cfg(9, 'edit'))
    // only the rolling copy and the layout (today's snapshot was taken by the save above)
    expect(puts).toEqual([PREV_KEY, 'dashboard:default'])
  })

  it('no stored config: just saves', async () => {
    const { kv, puts } = fakeKv()
    await put(kv, cfg(9))
    expect(puts).toEqual(['dashboard:default'])
  })

  it('refuses a save from an OLDER layout version with 409 and a clear message, without touching KV', async () => {
    const newer = JSON.stringify(cfg(9, 'migrated'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': newer })
    const res = await put(kv, cfg(8, 'old tab'))
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.message).toMatch(/out of date, reload/)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(newer)
  })

  it('fails closed: if the backup write fails, the stored layout is left untouched', async () => {
    const old = JSON.stringify(cfg(8, 'old'))
    const store = new Map([['dashboard:default', old]])
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        if (k.includes(':backup:')) throw new Error('KV write failed')
        store.set(k, v)
      },
    }
    await expect(put(kv, cfg(9, 'new'))).rejects.toThrow()
    expect(store.get('dashboard:default')).toBe(old)
  })

  it('refuses a version above the code\'s CONFIG_VERSION with 400, so a crafted body cannot lock tabs out', async () => {
    const current = JSON.stringify(cfg(CONFIG_VERSION))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': current })
    const res = await put(kv, { ...cfg(1e9), version: 1e9 })
    expect(res.status).toBe(400)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(current)
    // and a real tab can still save afterwards
    expect((await put(kv, cfg(CONFIG_VERSION, 'real'))).status).toBe(200)
  })

  it('still rejects a body with no pages or widgets, without touching KV', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(8)) })
    const res = await put(kv, { version: 9 })
    expect(res.status).toBe(400)
    expect(puts).toEqual([])
  })
})

describe('the v10 → v11 upgrade (the rest of the panels as cards and charts)', () => {
  it('this code writes layout version 11 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(11)
  })
  it('the first v11 save over a stored v10 layout backs it up to backup:v10, once', async () => {
    const v10 = JSON.stringify(cfg(10, 'v10 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v10 })
    expect((await put(kv, cfg(11, 'first v11'))).status).toBe(200)
    expect(backupKeyFor(10)).toBe('dashboard:default:backup:v10')
    expect(store.get('dashboard:default:backup:v10')).toBe(v10)
    await put(kv, cfg(11, 'second v11'))
    expect(store.get('dashboard:default:backup:v10')).toBe(v10) // never overwritten
    expect(JSON.parse(store.get('dashboard:default')!).pages[0].tag).toBe('second v11')
  })
  it('production is still stored at v8: the first v11 save backs up v8, never a later version', async () => {
    const v8 = JSON.stringify(cfg(8, 'v8 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v8 })
    expect((await put(kv, cfg(11, 'first v11'))).status).toBe(200)
    expect(store.get('dashboard:default:backup:v8')).toBe(v8)
    expect([...store.keys()].filter((k) => k.includes('backup'))).toEqual(['dashboard:default:backup:v8'])
  })
  it('a v10 tab saving over a stored v11 layout gets 409; a body above CONFIG_VERSION gets 400', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(11)) })
    expect((await put(kv, cfg(10, 'old tab'))).status).toBe(409)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })
})

describe('the v11 → v12 upgrade (the Overview small-sample note takes one grid row)', () => {
  it('this code writes layout version 12 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(12)
  })
  it('the first v12 save over a stored v11 layout backs it up to backup:v11; a v11 tab then gets 409', async () => {
    const v11 = JSON.stringify(cfg(11, 'v11 layout'))
    const { kv, store } = fakeKv({ 'dashboard:default': v11 })
    expect((await put(kv, cfg(12, 'first v12'))).status).toBe(200)
    expect(store.get('dashboard:default:backup:v11')).toBe(v11)
    expect((await put(kv, cfg(11, 'old tab'))).status).toBe(409)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
  })
})

// Layout version 13 (page navigation: groups, drill parents, icons; the active page per viewer).
// The live dashboard is stored at v12 when this ships: the first v13 save backs it up, and any tab
// still running v12 code must fail safely from then on — refused with 409, KV untouched — never
// overwrite the v13 layout (which would silently undo the migration for everyone).
describe('the v12 → v13 upgrade (page navigation)', () => {
  it('this code writes layout version 13 or later', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.navigation)
  })
  it('the first v13 save over the stored v12 layout backs it up to backup:v12, once', async () => {
    const v12 = JSON.stringify(cfg(12, 'live v12 layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v12 })
    expect((await put(kv, cfg(13, 'first v13'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default:backup:v12', DAY, PREV_KEY, 'dashboard:default'])
    expect(store.get('dashboard:default:backup:v12')).toBe(v12)
    await put(kv, cfg(13, 'second v13'))
    expect(store.get('dashboard:default:backup:v12')).toBe(v12) // never overwritten
  })
  it('an old v12 tab saving over a stored v13 layout gets 409 "out of date, reload", and KV is untouched', async () => {
    const v13 = JSON.stringify(cfg(13, 'migrated'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v13 })
    const res = await put(kv, cfg(12, 'old tab'))
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body).toMatchObject({ error: 'stale', storedVersion: 13, incomingVersion: 12 })
    expect(body.message).toMatch(/out of date, reload/)
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(v13)
    expect([...store.keys()]).toEqual(['dashboard:default']) // no backup written either
  })
  it('a body claiming a version above CONFIG_VERSION gets 400 and changes nothing', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': JSON.stringify(cfg(CONFIG_VERSION)) })
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })
})

// Layout version 14 (inline sparklines): a guard bump only, no layout rewrite. Page navigation
// holds 13, so a tab on the nav build (v13) must be refused once a v14 layout is stored.
describe('the v13 → v14 upgrade (inline sparklines: a guard bump, no layout rewrite)', () => {
  it('layout version 14 is the sparklines step (this code writes 15: see the v14 → v15 block)', () => {
    expect(LAYOUT_VERSIONS.navigation).toBe(13)
    expect(LAYOUT_VERSIONS.sparklines).toBe(14)
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(14)
  })
  it('the first v14 save over a stored v13 layout backs it up to backup:v13, once', async () => {
    const v13 = JSON.stringify(cfg(13, 'live v13 layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v13 })
    expect((await put(kv, cfg(14, 'first v14'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default:backup:v13', DAY, PREV_KEY, 'dashboard:default'])
    expect(store.get('dashboard:default:backup:v13')).toBe(v13)
    expect(store.get(backupKeyFor(13))).toBe(v13)
    await put(kv, cfg(14, 'second v14'))
    expect(store.get('dashboard:default:backup:v13')).toBe(v13) // never overwritten
  })
  it('a PUT carrying version 13 over a stored v14 layout gets 409, and KV is untouched', async () => {
    const v14 = JSON.stringify(cfg(14, 'sparkline layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v14 })
    const res = await put(kv, cfg(13, 'nav-build tab'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'stale', storedVersion: 14, incomingVersion: 13 })
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(v14)
    expect([...store.keys()]).toEqual(['dashboard:default'])
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
  })
})

// Layout version 15 (the default geo trend charts move to the ET-day axis, migrateDateEtTrendsV15):
// a data migration, so the stored v14 layout is backed up before the first v15 save replaces it.
describe('the v14 → v15 upgrade (default trend charts on dateEt)', () => {
  it('layout version 15 is the dateEt step (this code writes a newer one: see the captions block)', () => {
    expect(LAYOUT_VERSIONS.dateEtTrends).toBe(15)
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(LAYOUT_VERSIONS.dateEtTrends)
  })
  it('the first v15 save over a stored v14 layout backs it up to backup:v14, once', async () => {
    const v14 = JSON.stringify(cfg(14, 'live v14 layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v14 })
    expect((await put(kv, cfg(15, 'first v15'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default:backup:v14', DAY, PREV_KEY, 'dashboard:default'])
    expect(store.get(backupKeyFor(14))).toBe(v14)
    await put(kv, cfg(15, 'second v15'))
    expect(store.get('dashboard:default:backup:v14')).toBe(v14) // never overwritten
  })
  it('a PUT carrying version 14 over a stored v15 layout gets 409, and KV is untouched', async () => {
    const v15 = JSON.stringify(cfg(15, 'dateEt layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': v15 })
    const res = await put(kv, cfg(14, 'sparkline-build tab'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'stale', storedVersion: 15, incomingVersion: 14 })
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(v15)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
  })
})

// Chart captions (notes plan slice 1c: Widget.caption, Widget.hiddenCaveats). Unlike v14 this is a
// layout rewrite, not a guard bump: the v16 step seeds `hiddenCaveats` once on a pre-v16 layout
// (lib/defaults.ts seedHiddenAutoCaveatsV16), so rolling back past v16 means restoring the
// `backup:v<stored>` copy. Written against the LAYOUT_VERSIONS key, never a literal, so whichever
// slice lands second only renumbers the map.
describe('the captions upgrade (plain-text captions and hidden caveats: seeds hiddenCaveats once, a layout rewrite)', () => {
  const V = LAYOUT_VERSIONS.captions
  const prev = Math.max(...Object.values(LAYOUT_VERSIONS).filter((v) => v < V))
  it('captions is the newest layout version, and this code writes it', () => {
    expect(V).toBeGreaterThan(LAYOUT_VERSIONS.dateEtTrends)
    expect(CONFIG_VERSION).toBe(V)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
  })
  it('the first captions save over the stored previous layout backs it up to backup:v<prev>, once', async () => {
    const old = JSON.stringify(cfg(prev, 'live layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': old })
    expect((await put(kv, cfg(V, 'first captions save'))).status).toBe(200)
    expect(puts).toEqual([backupKeyFor(prev), DAY, PREV_KEY, 'dashboard:default'])
    expect(backupKeyFor(prev)).toBe(`dashboard:default:backup:v${prev}`)
    expect(store.get(backupKeyFor(prev))).toBe(old)
    await put(kv, cfg(V, 'second captions save'))
    expect(store.get(backupKeyFor(prev))).toBe(old) // never overwritten
    expect([...store.keys()].filter((k) => k.includes('backup'))).toEqual([backupKeyFor(prev)])
  })
  it('a PUT carrying the previous version over a stored captions layout gets 409, and KV is untouched', async () => {
    const cur = JSON.stringify(cfg(V, 'captions layout'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': cur })
    const res = await put(kv, cfg(prev, 'older tab'))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'stale', storedVersion: V, incomingVersion: prev })
    expect(puts).toEqual([])
    expect(store.get('dashboard:default')).toBe(cur)
    expect([...store.keys()]).toEqual(['dashboard:default'])
    expect((await put(kv, cfg(V + 1, 'crafted'))).status).toBe(400)
  })
})

// The server-side backstop to the client's load guard (#62): a tab that never loaded the real
// layout can still PUT defaults at the CURRENT layout version, which the 409 cannot catch. Every
// save that changes the stored layout first copies what was stored to `:prev`, and the first such
// save of each ET day also to `:day:<date>` (30-day TTL), so the owner's layout stays recoverable.
describe('rolling and daily backups before a changing save', () => {
  const real = JSON.stringify(cfg(CONFIG_VERSION, 'owner layout'))

  it('copies the stored raw value to :prev before writing a changed layout', async () => {
    const stored = `${real}\n` // raw bytes, not a re-serialization
    const { kv, store, puts } = fakeKv({ 'dashboard:default': stored, [DAY]: 'taken earlier today' })
    expect((await put(kv, cfg(CONFIG_VERSION, 'edit'))).status).toBe(200)
    expect(puts).toEqual([PREV_KEY, 'dashboard:default'])
    expect(store.get(PREV_KEY)).toBe(stored)
    expect(JSON.parse(store.get('dashboard:default')!).pages[0].tag).toBe('edit')
  })

  it('takes no copy (no :prev, no :day:) when the save is identical to what is stored, but still writes the layout', async () => {
    // The read can be stale at another Cloudflare location, so "identical" is not proof the key
    // already holds this body: the layout is written anyway, only the copies are skipped.
    const { kv, store, puts } = fakeKv({ 'dashboard:default': real, [PREV_KEY]: 'older' })
    const res = await put(kv, JSON.parse(real))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(puts).toEqual(['dashboard:default'])
    expect(store.get(PREV_KEY)).toBe('older')
    expect(store.has(DAY)).toBe(false)
  })

  it('a body that differs from what is stored only in its bytes still counts as a change', async () => {
    const pretty = JSON.stringify(cfg(CONFIG_VERSION, 'owner layout'), null, 2)
    const { kv, puts } = fakeKv({ 'dashboard:default': pretty, [DAY]: 'x' })
    await put(kv, cfg(CONFIG_VERSION, 'owner layout'))
    expect(puts).toEqual([PREV_KEY, 'dashboard:default'])
  })

  it('no stored layout: nothing to back up, only the layout is written', async () => {
    const { kv, puts } = fakeKv()
    await put(kv, cfg(CONFIG_VERSION))
    expect(puts).toEqual(['dashboard:default'])
  })

  it('the first changing save of an ET day snapshots the stored value to :day:<date> with a 30-day TTL, once', async () => {
    const { kv, store, puts, options } = fakeKv({ 'dashboard:default': real })
    await put(kv, cfg(CONFIG_VERSION, 'first edit'))
    expect(puts).toEqual([DAY, PREV_KEY, 'dashboard:default'])
    expect(DAY).toBe('dashboard:default:day:2026-10-03')
    expect(store.get(DAY)).toBe(real)
    expect(options.get(DAY)).toEqual({ expirationTtl: 30 * 24 * 60 * 60 })
    expect(DAY_SNAPSHOT_TTL_SECONDS).toBe(2_592_000)
    expect(options.has(PREV_KEY)).toBe(false) // :prev and the layout never expire
    expect(options.has('dashboard:default')).toBe(false)
    puts.length = 0
    await put(kv, cfg(CONFIG_VERSION, 'second edit'))
    expect(puts).toEqual([PREV_KEY, 'dashboard:default'])
    expect(store.get(DAY)).toBe(real) // still the start-of-day layout
  })

  it('the day is the ET calendar day: 23:30 EDT is still the same day, 00:30 EDT is the next', async () => {
    const { kv, store, puts } = fakeKv({ 'dashboard:default': real })
    await put(kv, cfg(CONFIG_VERSION, 'noon'))
    vi.setSystemTime(Date.parse('2026-10-04T03:30:00Z')) // 2026-10-03 23:30 EDT
    puts.length = 0
    await put(kv, cfg(CONFIG_VERSION, 'late evening'))
    expect(puts).toEqual([PREV_KEY, 'dashboard:default'])
    vi.setSystemTime(Date.parse('2026-10-04T04:30:00Z')) // 2026-10-04 00:30 EDT
    puts.length = 0
    await put(kv, cfg(CONFIG_VERSION, 'after midnight'))
    expect(puts).toEqual([dayKeyFor('2026-10-04'), PREV_KEY, 'dashboard:default'])
    expect(JSON.parse(store.get(dayKeyFor('2026-10-04'))!).pages[0].tag).toBe('late evening')
  })

  it('in winter (EST) the ET day turns at 05:00 UTC', async () => {
    vi.setSystemTime(Date.parse('2026-12-15T04:30:00Z')) // 2026-12-14 23:30 EST
    const { kv, puts } = fakeKv({ 'dashboard:default': real })
    await put(kv, cfg(CONFIG_VERSION, 'edit'))
    expect(puts).toEqual([dayKeyFor('2026-12-14'), PREV_KEY, 'dashboard:default'])
  })

  it('an identical save never takes the daily snapshot', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': real })
    await put(kv, JSON.parse(real))
    expect(puts).toEqual(['dashboard:default'])
  })

  it('a stale cross-location read that sees the body as identical still lands the save', async () => {
    // Location B still reads the old layout G after location A stored A; a revert to G served by
    // B must write G, not answer 200 and leave A in place.
    const store = new Map([['dashboard:default', 'A-at-the-origin']])
    const kv = {
      get: async (k: string) => (k === 'dashboard:default' ? real : store.get(k) ?? null),
      put: async (k: string, v: string) => void store.set(k, v),
    }
    expect((await put(kv, JSON.parse(real))).status).toBe(200)
    expect(store.get('dashboard:default')).toBe(real)
  })

  it('an empty stored value is treated as nothing stored, as the version guards do', async () => {
    const { kv, store, puts } = fakeKv({ 'dashboard:default': '', [PREV_KEY]: 'kept' })
    expect((await put(kv, cfg(CONFIG_VERSION, 'edit'))).status).toBe(200)
    expect(puts).toEqual(['dashboard:default'])
    expect(store.get(PREV_KEY)).toBe('kept')
  })

  it('defaults saved over the owner layout, then several more edits: :day: still holds the owner layout', async () => {
    const { kv, store } = fakeKv({ 'dashboard:default': real })
    await put(kv, cfg(CONFIG_VERSION, 'defaults from a tab that never loaded'))
    await put(kv, cfg(CONFIG_VERSION, 'defaults, card moved'))
    await put(kv, cfg(CONFIG_VERSION, 'defaults, card moved again'))
    expect(JSON.parse(store.get(PREV_KEY)!).pages[0].tag).toBe('defaults, card moved') // rotated
    expect(store.get(DAY)).toBe(real) // recoverable
  })

  it('on a version bump the version backup still comes first, then :day: and :prev, then the layout', async () => {
    const older = JSON.stringify(cfg(CONFIG_VERSION - 1, 'older version'))
    const { kv, store, puts } = fakeKv({ 'dashboard:default': older })
    expect((await put(kv, cfg(CONFIG_VERSION, 'migrated'))).status).toBe(200)
    expect(puts).toEqual([backupKeyFor(CONFIG_VERSION - 1), DAY, PREV_KEY, 'dashboard:default'])
    expect(store.get(backupKeyFor(CONFIG_VERSION - 1))).toBe(older)
    expect(store.get(PREV_KEY)).toBe(older)
    expect(store.get(DAY)).toBe(older)
  })

  it('a refused save (409 stale, 400 invalid or too new) writes no :prev or :day: copy', async () => {
    const { kv, puts } = fakeKv({ 'dashboard:default': real })
    expect((await put(kv, cfg(CONFIG_VERSION - 1, 'old tab'))).status).toBe(409)
    expect((await put(kv, { version: CONFIG_VERSION })).status).toBe(400)
    expect((await put(kv, cfg(CONFIG_VERSION + 1, 'crafted'))).status).toBe(400)
    expect(puts).toEqual([])
  })

  describe('fails closed: a backup that cannot be written refuses the save with 503 and leaves the layout untouched', () => {
    function failingKv(fail: (op: 'get' | 'put', key: string) => boolean, initial: Record<string, string>) {
      const store = new Map(Object.entries(initial))
      const puts: string[] = []
      return {
        store,
        puts,
        kv: {
          get: async (k: string) => {
            if (fail('get', k)) throw new Error('KV read failed')
            return store.get(k) ?? null
          },
          put: async (k: string, v: string) => {
            if (fail('put', k)) throw new Error('KV write failed')
            puts.push(k)
            store.set(k, v)
          },
        },
      }
    }
    const cases: [string, (op: 'get' | 'put', key: string) => boolean][] = [
      [':prev write throws', (op, k) => op === 'put' && k === PREV_KEY],
      [':day: write throws', (op, k) => op === 'put' && k.includes(':day:')],
      [':day: read throws', (op, k) => op === 'get' && k.includes(':day:')],
    ]
    for (const [name, fail] of cases) {
      it(`${name}: layout and :prev both untouched`, async () => {
        const { kv, store, puts } = failingKv(fail, { 'dashboard:default': real, [PREV_KEY]: 'the good one' })
        const res = await put(kv, cfg(CONFIG_VERSION, 'would overwrite'))
        expect(res.status).toBe(503)
        expect(res.ok).toBe(false)
        expect(await res.json()).toMatchObject({ error: 'backup-failed' })
        expect(store.get('dashboard:default')).toBe(real)
        expect(puts).not.toContain('dashboard:default')
        // A refused save must not rotate :prev either: the owner sees "Save failed" and may
        // reasonably count on :prev still holding the layout from before the last saved change.
        expect(store.get(PREV_KEY)).toBe('the good one')
      })
    }

    it(':prev write throws after the day copy landed: the day copy holds the unchanged stored layout', async () => {
      const { kv, store } = failingKv((op, k) => op === 'put' && k === PREV_KEY, { 'dashboard:default': real })
      expect((await put(kv, cfg(CONFIG_VERSION, 'would overwrite'))).status).toBe(503)
      expect(store.get(DAY)).toBe(real)
      expect(store.get('dashboard:default')).toBe(real)
    })

    it('on a version bump, :prev failing leaves the version backup (correct content) and the layout as it was; a retry succeeds', async () => {
      const older = JSON.stringify(cfg(CONFIG_VERSION - 1, 'older version'))
      let failPrev = true
      const { kv, store, puts } = failingKv((op, k) => failPrev && op === 'put' && k === PREV_KEY, { 'dashboard:default': older })
      expect((await put(kv, cfg(CONFIG_VERSION, 'migrated'))).status).toBe(503)
      expect(store.get('dashboard:default')).toBe(older)
      expect(store.get(backupKeyFor(CONFIG_VERSION - 1))).toBe(older)
      failPrev = false
      puts.length = 0
      expect((await put(kv, cfg(CONFIG_VERSION, 'migrated'))).status).toBe(200)
      expect(puts).toEqual([PREV_KEY, 'dashboard:default']) // version backup and day copy already in place
      expect(store.get(PREV_KEY)).toBe(older)
    })

    it('the layout write itself throwing fails the request; the copies already written equal the unchanged layout', async () => {
      const { kv, store } = failingKv((op, k) => op === 'put' && k === 'dashboard:default', { 'dashboard:default': real })
      await expect(put(kv, cfg(CONFIG_VERSION, 'would overwrite'))).rejects.toThrow()
      expect(store.get('dashboard:default')).toBe(real)
      expect(store.get(PREV_KEY)).toBe(real)
      expect(store.get(DAY)).toBe(real)
    })
  })
})
